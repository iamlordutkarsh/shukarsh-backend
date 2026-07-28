import type { CouponType } from "@prisma/client";
import { prisma } from "./prisma";
import { round2 } from "./tax";
import type { PricedLine } from "./shipping";

/** A coupon with its targeting loaded, which is all the maths here needs. */
export type CouponWithTargets = Awaited<ReturnType<typeof findCoupon>>;

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function findCoupon(code: string) {
  return prisma.coupon.findUnique({
    where: { code: normalizeCode(code) },
    include: {
      categories: { select: { categoryId: true } },
      products: { select: { productId: true } },
    },
  });
}

export interface AppliedCoupon {
  couponId: string;
  code: string;
  type: CouponType;
  description: string | null;
  /** Rupees off the items. Always zero for a free-shipping code. */
  discount: number;
  freeShipping: boolean;
  /** How the discount was split across the cart, by line position. */
  perLine: number[];
}

export type CouponOutcome =
  | { ok: true; applied: AppliedCoupon }
  | { ok: false; reason: string };

function money(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * Which cart lines a coupon is allowed to touch.
 *
 * A coupon with no categories and no products applies to everything. Give it
 * either and it only reaches matching lines, so "25% off dresses" discounts the
 * dresses and leaves the rest of the bag alone.
 */
function eligibleIndexes(coupon: NonNullable<CouponWithTargets>, lines: PricedLine[]): number[] {
  const productIds = new Set(coupon.products.map((row) => row.productId));
  const categoryIds = new Set(coupon.categories.map((row) => row.categoryId));

  if (productIds.size === 0 && categoryIds.size === 0) return lines.map((_, index) => index);

  return lines.reduce<number[]>((indexes, line, index) => {
    if (productIds.has(line.productId) || categoryIds.has(line.categoryId)) indexes.push(index);
    return indexes;
  }, []);
}

/**
 * Splits a discount across the lines it applies to, in proportion to what each
 * is worth.
 *
 * This matters for more than tidiness: GST is charged per line at that line's
 * own rate, so the taxman's share depends on which lines the money came off.
 * The last line absorbs the rounding remainder, which keeps the parts adding up
 * to exactly the discount the customer was promised.
 */
export function allocateDiscount(
  lines: Pick<PricedLine, "gross">[],
  indexes: number[],
  discount: number
): number[] {
  const perLine = lines.map(() => 0);
  if (discount <= 0 || indexes.length === 0) return perLine;

  const subtotal = indexes.reduce((total, index) => total + lines[index].gross, 0);
  if (subtotal <= 0) return perLine;

  let assigned = 0;
  for (let position = 0; position < indexes.length - 1; position++) {
    const index = indexes[position];
    const share = round2(discount * (lines[index].gross / subtotal));
    perLine[index] = share;
    assigned = round2(assigned + share);
  }

  perLine[indexes[indexes.length - 1]] = round2(discount - assigned);
  return perLine;
}

/**
 * Who a limit counts against.
 *
 * A signed-in customer is tracked by account. A guest can only be tracked by
 * the email they typed, which a determined person can change, so treat the
 * per-customer limit as a speed bump rather than a lock.
 *
 * The match is case-insensitive rather than lowercasing the input: emails are
 * normalised on write now, but rows written before that kept whatever the
 * customer typed, and an exact match would read those as a different person.
 */
function identityFilter(userId: string | null | undefined, email: string | null | undefined) {
  if (userId) return { userId };
  if (email) return { email: { equals: email, mode: "insensitive" as const } };
  return null;
}

/** How many times this customer has already used this code. */
async function redemptionCount(
  couponId: string,
  userId: string | null | undefined,
  email: string | null | undefined
): Promise<number> {
  const identity = identityFilter(userId, email);
  if (!identity) return 0;

  // Orders still waiting to be paid count as well. A redemption is only booked
  // once the money arrives, so counting redemptions alone lets someone run
  // checkout five times, sit on five PENDING orders each carrying the code, and
  // then pay all five. No race needed and no limit reached.
  const [redeemed, held] = await Promise.all([
    prisma.couponRedemption.count({ where: { couponId, ...identity } }),
    prisma.order.count({ where: { couponId, ...identity, paymentStatus: "PENDING" } }),
  ]);

  return redeemed + held;
}

async function hasEarlierOrder(
  userId: string | null | undefined,
  email: string | null | undefined
): Promise<boolean> {
  const identity = identityFilter(userId, email);
  if (!identity) return false;

  const count = await prisma.order.count({ where: { ...identity, paymentStatus: "PAID" } });
  return count > 0;
}

export interface CouponContext {
  lines: PricedLine[];
  userId?: string | null;
  email?: string | null;
}

/**
 * Decides whether a code applies to this bag and what it is worth.
 *
 * Returns a reason instead of throwing, because a bad code should still leave
 * the customer with a priced bag and an explanation rather than an error page.
 */
export async function evaluateCoupon(
  coupon: CouponWithTargets,
  context: CouponContext
): Promise<CouponOutcome> {
  if (!coupon) return { ok: false, reason: "That code does not exist." };
  if (!coupon.isActive) return { ok: false, reason: "That code is no longer active." };

  const now = new Date();
  if (coupon.startsAt && now < coupon.startsAt) {
    return { ok: false, reason: "That code is not live yet." };
  }
  if (coupon.expiresAt && now > coupon.expiresAt) {
    return { ok: false, reason: "That code has expired." };
  }
  if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
    return { ok: false, reason: "That code has been fully claimed." };
  }

  if (coupon.perUserLimit != null) {
    const used = await redemptionCount(coupon.id, context.userId, context.email);
    if (used >= coupon.perUserLimit) {
      return {
        ok: false,
        reason:
          coupon.perUserLimit === 1
            ? "You have already used that code."
            : `That code can only be used ${coupon.perUserLimit} times per customer.`,
      };
    }
  }

  if (coupon.firstOrderOnly && (await hasEarlierOrder(context.userId, context.email))) {
    return { ok: false, reason: "That code is only for a first order." };
  }

  const indexes = eligibleIndexes(coupon, context.lines);
  if (indexes.length === 0) {
    return { ok: false, reason: "That code does not apply to anything in your bag." };
  }

  const eligibleSubtotal = round2(
    indexes.reduce((total, index) => total + context.lines[index].gross, 0)
  );
  const minOrderValue = Number(coupon.minOrderValue);

  if (eligibleSubtotal < minOrderValue) {
    const short = round2(minOrderValue - eligibleSubtotal);
    return {
      ok: false,
      reason:
        indexes.length === context.lines.length
          ? `Spend ${money(short)} more to use that code.`
          : `Add ${money(short)} more of the items that code covers to use it.`,
    };
  }

  const value = Number(coupon.value);
  let discount = 0;
  let freeShipping = false;

  switch (coupon.type) {
    case "PERCENT": {
      discount = round2((eligibleSubtotal * value) / 100);
      const cap = coupon.maxDiscount != null ? Number(coupon.maxDiscount) : null;
      if (cap != null && discount > cap) discount = cap;
      break;
    }
    case "FLAT":
      discount = value;
      break;
    case "FREE_SHIPPING":
      freeShipping = true;
      break;
  }

  // A code can take the items to zero but never below it, or the order would
  // owe the customer money.
  discount = round2(Math.min(discount, eligibleSubtotal));

  if (discount <= 0 && !freeShipping) {
    return { ok: false, reason: "That code is worth nothing on this bag." };
  }

  return {
    ok: true,
    applied: {
      couponId: coupon.id,
      code: coupon.code,
      type: coupon.type,
      description: coupon.description,
      discount,
      freeShipping,
      perLine: allocateDiscount(context.lines, indexes, discount),
    },
  };
}

/**
 * Books a redemption against an order at the moment it is confirmed, rather
 * than when it was merely placed, so an abandoned checkout never eats into a
 * code's total count.
 *
 * The count goes up unconditionally and on purpose. By the time this runs the
 * customer has paid the discounted amount, so the redemption is a fact whether
 * or not the code has since run out; refusing it here would leave money taken
 * against a discount nobody recorded. `usageLimit` is enforced where it can
 * still be honoured, when the code is applied and again before payment starts.
 * The cost is that concurrent checkouts can carry a limited code a use or two
 * past its cap, which is the right way round: better to slightly overshoot than
 * to void a discount someone has already been charged for.
 *
 * Only ever called from inside the transaction that claims the order, which is
 * what stops the browser callback and the webhook booking it twice.
 */
export async function recordRedemption(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  params: {
    couponId: string;
    orderId: string;
    userId?: string | null;
    email?: string | null;
    amount: number;
  }
): Promise<void> {
  await tx.coupon.update({
    where: { id: params.couponId },
    data: { usageCount: { increment: 1 } },
  });

  await tx.couponRedemption.create({
    data: {
      couponId: params.couponId,
      orderId: params.orderId,
      userId: params.userId ?? null,
      email: params.email?.toLowerCase() ?? null,
      amount: params.amount,
    },
  });
}
