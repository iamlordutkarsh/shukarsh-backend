import crypto from "crypto";
import { prisma } from "./prisma";

/**
 * How long a recovery link keeps working.
 *
 * Generous on purpose. The reminder goes out before the checkout is called off,
 * but people read their email days late, and the link only rebuilds a bag: prices,
 * stock and delivery are all worked out again at checkout, so an old link cannot
 * sell anything at yesterday's terms.
 */
const LINK_DAYS = 30;

function secret(): string | null {
  return process.env.JWT_SECRET || null;
}

function sign(orderId: string, key: string): string {
  return crypto.createHmac("sha256", key).update(orderId).digest("hex").slice(0, 32);
}

/**
 * Where an abandoned checkout can be picked up again, or null when it cannot be
 * signed. An unsigned link would be one anybody could work out from an order id,
 * and no link at all beats a guessable one.
 */
export function recoveryPath(orderId: string): string | null {
  const key = secret();
  if (!key) return null;
  return `/cart/recover?order=${orderId}&token=${sign(orderId, key)}`;
}

/** Whether a link was signed by us and not edited on the way. */
export function recoveryTokenMatches(orderId: string, token: string): boolean {
  const key = secret();
  if (!key) return false;

  const expected = Buffer.from(sign(orderId, key), "utf8");
  const given = Buffer.from(token, "utf8");
  // Same length first: timingSafeEqual throws rather than returns false on a
  // mismatch, and the length is not the secret.
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface RecoveredLine {
  productId: string;
  quantity: number;
}

/**
 * What the customer had picked out, for a checkout they never paid for.
 *
 * Anything already paid for is refused: there is nothing to recover, and the link
 * has no business reporting on a live order. A cancelled one is still fair game,
 * since the sweep calls checkouts off after a day and somebody reading their email
 * on Monday should not be punished for it.
 */
export async function recoverLines(orderId: string, token: string): Promise<RecoveredLine[] | null> {
  if (!recoveryTokenMatches(orderId, token)) return null;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      paymentStatus: true,
      createdAt: true,
      items: { select: { productId: true, quantity: true } },
    },
  });

  if (!order || order.paymentStatus === "PAID") return null;
  if (order.createdAt < new Date(Date.now() - LINK_DAYS * 24 * 60 * 60 * 1000)) return null;

  return order.items.map((item) => ({ productId: item.productId, quantity: item.quantity }));
}
