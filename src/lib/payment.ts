import crypto from "crypto";
import { prisma } from "./prisma";
import { recordRedemption } from "./coupon";
import { moveStock } from "./inventory";

export interface PaidResult {
  orderId: string;
  /** True when someone else had already marked this order paid. */
  alreadyPaid: boolean;
}

/**
 * Marks an order paid exactly once.
 *
 * Two things race here: the browser calling /verify after Razorpay's callback,
 * and Razorpay's own webhook. The claim is a conditional update inside the
 * transaction, so whichever arrives second sees zero rows matched and skips the
 * stock decrement rather than running it twice.
 */
export async function markOrderPaid(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature?: string;
}): Promise<PaidResult | null> {
  const order = await prisma.order.findUnique({
    where: { razorpayOrderId: params.razorpayOrderId },
    include: { items: true },
  });

  if (!order) return null;

  // A Razorpay link stays open after we have closed the order, so money can
  // still arrive for one the customer called off or the abandoned-checkout sweep
  // expired. It has to go on record, but the shelf must be left alone: nobody is
  // going to ship this. stockReleased says the units are not held, so an admin
  // reopening the order takes them properly.
  const cancelled = order.status === "CANCELLED" || order.status === "RETURNED";

  return prisma.$transaction(async (tx) => {
    const claim = await tx.order.updateMany({
      where: { razorpayOrderId: params.razorpayOrderId, paymentStatus: { not: "PAID" } },
      data: {
        paymentStatus: "PAID",
        paidAt: new Date(),
        ...(cancelled ? { stockReleased: true } : {}),
        // Payment does not advance the status. A paid order waits on Pending
        // until the shop approves it, which is what the To approve queue in the
        // admin panel is for. Moving it to Processing here skipped that queue
        // entirely and no order ever appeared in it.
        razorpayPaymentId: params.razorpayPaymentId,
        ...(params.razorpaySignature ? { razorpaySignature: params.razorpaySignature } : {}),
      },
    });

    if (claim.count === 0) {
      return { orderId: order.id, alreadyPaid: true };
    }

    if (cancelled) {
      console.warn(
        `Payment ${params.razorpayPaymentId} arrived for cancelled order ${order.id}. Recorded, no stock taken; this one needs a refund decision.`
      );
    } else {
      for (const item of order.items) {
        // Unconditional on purpose. The bag was checked against the shelf when it
        // was priced, and money has now changed hands: refusing to record the sale
        // because the count has since slipped would lose the sale, not fix it. A
        // negative balance on the ledger is a visible problem, which is what we
        // want here.
        await moveStock(tx, {
          productId: item.productId,
          variantId: item.variantId,
          delta: -item.quantity,
          reason: "SALE",
          orderId: order.id,
          allowNegative: true,
        });
      }
    }

    // Inside the same claim as the stock, so whichever of the browser callback
    // and the webhook loses the race books neither.
    if (order.couponId) {
      await recordRedemption(tx, {
        couponId: order.couponId,
        orderId: order.id,
        userId: order.userId,
        email: order.email,
        amount: Number(order.discountTotal),
      });
    }

    return { orderId: order.id, alreadyPaid: false };
  });
}

export function isWebhookConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
}

/**
 * Razorpay signs the exact bytes it sent, so this has to run against the raw
 * body rather than anything JSON.stringify would produce.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = Buffer.from(signature);
  const digest = Buffer.from(expected);

  if (provided.length !== digest.length) return false;
  return crypto.timingSafeEqual(provided, digest);
}

export interface WebhookPayment {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}

/** Pulls the order and payment ids out of the events we act on. */
export function paymentFromWebhook(body: any): WebhookPayment | null {
  const event = typeof body?.event === "string" ? body.event : null;
  if (event !== "payment.captured" && event !== "order.paid") return null;

  const payment = body?.payload?.payment?.entity;
  if (!payment?.order_id || !payment?.id) return null;

  return { razorpayOrderId: String(payment.order_id), razorpayPaymentId: String(payment.id) };
}
