import { round2 } from "./tax";

/**
 * What the shop charges to deliver an order, which is a different question from
 * what the courier charges the shop.
 *
 * Pricing the first off the second is what this replaces. A live courier rate
 * means two customers pay different amounts for the same dress because one of
 * them lives further away, it publishes what the shop pays to anyone with a
 * pincode, and it makes the total depend on a third party being reachable.
 * Delivery is a promise the shop makes, so it is set here and the variance is
 * absorbed. Surveying real rates is what `npm run rates:survey` is for.
 */

const DEFAULT_FREE_ABOVE = 299;

export interface ShippingPolicy {
  /** At or above this order value, delivery is free. */
  freeAbove: number;
  /** Charged below it. Zero means delivery is simply free, everywhere. */
  flatFee: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function shippingPolicy(): ShippingPolicy {
  return {
    freeAbove: positiveNumber(process.env.SHIPPING_FREE_ABOVE, DEFAULT_FREE_ABOVE),
    flatFee: positiveNumber(process.env.SHIPPING_FLAT_FEE, 0),
  };
}

/**
 * `orderValue` is what the customer is actually paying for the goods, so after
 * any coupon. Measured before the discount, a big enough code would buy free
 * delivery on an order that never earned it.
 */
export function shippingFee(orderValue: number): number {
  const { freeAbove, flatFee } = shippingPolicy();
  return orderValue >= freeAbove ? 0 : flatFee;
}

/**
 * How much more is needed to stop paying for delivery, for the nudge in the bag.
 * Zero when the order is already there, and zero when there is no fee to escape,
 * so nothing offers a shopper a saving they are already getting.
 */
export function freeDeliveryShortfall(orderValue: number): number {
  const { freeAbove, flatFee } = shippingPolicy();
  if (flatFee === 0 || orderValue >= freeAbove) return 0;
  return round2(freeAbove - orderValue);
}
