import { prisma } from "./prisma";
import { applyOrderStatus } from "./order-status";

const DEFAULT_HOURS = 24;

/** How long a checkout is given to be paid for before it is called off. */
function graceHours(): number {
  const raw = Number(process.env.ABANDONED_ORDER_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS;
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
    expireAbandonedOrders().catch((error) => console.error("Abandoned order sweep failed:", error));
  };

  run();
  setInterval(run, SWEEP_INTERVAL_MS).unref();
}
