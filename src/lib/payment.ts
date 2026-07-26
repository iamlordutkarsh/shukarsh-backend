import crypto from "crypto";
import { prisma } from "./prisma";

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

  return prisma.$transaction(async (tx) => {
    const claim = await tx.order.updateMany({
      where: { razorpayOrderId: params.razorpayOrderId, paymentStatus: { not: "PAID" } },
      data: {
        paymentStatus: "PAID",
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

    for (const item of order.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
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
