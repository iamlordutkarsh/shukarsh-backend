import { prisma } from "./prisma";
import { applyOrderStatus } from "./order-status";
import { sendCartRecovery } from "./notifications";

const DEFAULT_HOURS = 24;

/** How long a checkout is given to be paid for before it is called off. */
function graceHours(): number {
  const raw = Number(process.env.ABANDONED_ORDER_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS;
}

/**
 * Halfway through the grace period.
 *
 * Late enough that the customer has plainly stopped rather than gone to find
 * their card, and early enough that the reminder still points at a checkout that
 * is alive. Tied to the grace period rather than set on its own, so shortening one
 * cannot leave the shop emailing about orders it already cancelled.
 */
function reminderAfterMs(): number {
  return (graceHours() / 2) * 60 * 60 * 1000;
}

/**
 * Asks people to come back to a checkout they never paid for.
 *
 * One email per order and never a second, which is why the attempt is recorded
 * before anything else can go wrong with the batch. An order with nowhere to send
 * to is left alone rather than marked, since there is no reminder to regret.
 *
 * Someone who abandoned a checkout and then bought the same thing on a second
 * attempt is skipped: a card that fails once often succeeds on the retry, and
 * telling that customer they forgot something reads as a shop that is not paying
 * attention.
 */
export async function remindAbandonedOrders(limit = 50): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - reminderAfterMs());
  const expiresAt = new Date(now - graceHours() * 60 * 60 * 1000);

  const waiting = await prisma.order.findMany({
    where: {
      paymentStatus: "PENDING",
      status: "PENDING",
      // Cash orders are unpaid by design until the courier collects. Without
      // this, each one gets an email asking the customer to go back and finish a
      // checkout they already completed.
      paymentMethod: "PREPAID",
      razorpayPaymentId: null,
      recoveryEmailAt: null,
      createdAt: { lt: cutoff, gt: expiresAt },
      items: { some: {} },
    },
    select: { id: true, email: true, userId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let sent = 0;

  for (const order of waiting) {
    try {
      const boughtSince = await prisma.order.count({
        where: {
          paymentStatus: "PAID",
          createdAt: { gte: order.createdAt },
          ...(order.userId
            ? { userId: order.userId }
            : order.email
              ? { email: order.email }
              : { id: "none" }),
        },
      });
      if (boughtSince > 0) continue;

      if (!(await sendCartRecovery(order.id))) continue;

      await prisma.order.update({
        where: { id: order.id },
        data: { recoveryEmailAt: new Date() },
      });
      sent += 1;
    } catch (error) {
      // One stuck order must not stop the rest of the batch.
      console.error(`Could not remind about abandoned order ${order.id}:`, error);
    }
  }

  if (sent > 0) console.log(`Sent ${sent} cart recovery email(s)`);
  return sent;
}

/**
 * Cancels checkouts that were never paid for.
 *
 * A per-customer coupon limit counts orders that are still awaiting payment,
 * because otherwise five unpaid checkouts could each carry a one-per-person
 * code and all be paid afterwards. The price of that is an abandoned checkout
 * sitting on the customer's one use of the code, so something has to let it go.
 *
 * Only orders that never got as far as a payment id are touched. Once Razorpay
 * has named a payment against an order, whatever happened next is a question
 * for a person and not for a timer.
 *
 * An expired checkout ends up as a plain cancelled order, deliberately
 * indistinguishable from one the customer called off themselves: nothing needs
 * to tell the two apart, and inventing a status for it would mean teaching
 * every screen and query about it.
 */
export async function expireAbandonedOrders(limit = 200): Promise<number> {
  const cutoff = new Date(Date.now() - graceHours() * 60 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: {
      paymentStatus: "PENDING",
      status: "PENDING",
      // Same reason, with sharper teeth: this one cancels what it finds, so a
      // cash order waiting to be packed would be called off a few hours after
      // the customer placed it.
      paymentMethod: "PREPAID",
      razorpayPaymentId: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let cancelled = 0;

  for (const order of stale) {
    try {
      // Through applyOrderStatus like every other status change, even though an
      // unpaid order is holding no stock for it to put back.
      await applyOrderStatus(order.id, "CANCELLED");
      cancelled += 1;
    } catch (error) {
      // One stuck order must not stop the rest of the batch.
      console.error(`Could not expire abandoned order ${order.id}:`, error);
    }
  }

  if (cancelled > 0) console.log(`Expired ${cancelled} abandoned checkout(s) older than ${graceHours()}h`);
  return cancelled;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * In-process sweep, hourly and with nothing to configure.
 *
 * It runs once on the way up as well, because a host that sleeps between
 * requests will never sit still long enough to reach the interval. Such a host
 * should also point a scheduler at POST /api/logistics/sync, which sweeps too.
 */
export function startAbandonedOrderSweep(): void {
  const run = () => {
    // Remind first, then cancel. The other order would call a checkout off in the
    // same pass that asked its customer to come back to it.
    remindAbandonedOrders()
      .catch((error) => console.error("Cart recovery sweep failed:", error))
      .then(() => expireAbandonedOrders())
      .catch((error) => console.error("Abandoned order sweep failed:", error));
  };

  run();
  setInterval(run, SWEEP_INTERVAL_MS).unref();
}
