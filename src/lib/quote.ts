import { evaluateCoupon, findCoupon, type AppliedCoupon } from "./coupon";
import { shippingFee } from "./shipping-policy";
import { priceCart, resolveShipping, type PricedCart, type ResolvedShipping } from "./shipping";
import { computeTax, round2, type TaxBreakdown } from "./tax";

export interface QuoteInput {
  items: { productId: string; quantity: number }[];
  pincode?: string;
  state?: string | null;
  courierId?: number;
  couponCode?: string | null;
  userId?: string | null;
  email?: string | null;
}

export interface Quote {
  cart: PricedCart;
  shipping: ResolvedShipping;
  tax: TaxBreakdown;
  coupon: AppliedCoupon | null;
  /** Why a code the customer typed did not stick. */
  couponError: string | null;
  /** Before any discount. */
  itemsTotal: number;
  discountTotal: number;
  shippingAmount: number;
  totalAmount: number;
  /** What each line is worth after its share of the discount came off. */
  netLineGross: number[];
}

/**
 * No pincode yet, so no courier and no delivery estimate. The fee is still the
 * shop's to state: it comes from the order value, not from where it is going,
 * which is what lets the bag say "free delivery" before an address exists.
 */
const NO_SHIPPING: ResolvedShipping = {
  amount: 0,
  courierId: null,
  courierName: null,
  option: null,
  quoted: false,
};

/**
 * The one place an order's money is worked out.
 *
 * The checkout page shows what this returns and /create charges it, so both
 * have to come through here. Two implementations would drift, and the way you
 * find out is a customer seeing one total on the page and a different one on
 * their card statement.
 *
 * Order of operations is deliberate. The discount comes off first, then the
 * delivery fee is decided against what is actually being paid, then GST is
 * worked out on the discounted amounts, because tax is owed on what the customer
 * really hands over and not on a price nobody paid.
 */
export async function buildQuote(input: QuoteInput): Promise<Quote> {
  const cart = await priceCart(input.items);

  let coupon: AppliedCoupon | null = null;
  let couponError: string | null = null;

  if (input.couponCode) {
    const found = await findCoupon(input.couponCode);
    const outcome = await evaluateCoupon(found, {
      lines: cart.lines,
      userId: input.userId,
      email: input.email,
    });

    if (outcome.ok) coupon = outcome.applied;
    else couponError = outcome.reason;
  }

  const discountTotal = coupon?.discount ?? 0;
  const netLineGross = cart.lines.map((line, index) =>
    round2(line.gross - (coupon?.perLine[index] ?? 0))
  );
  const netItemsTotal = round2(cart.itemsTotal - discountTotal);

  const quotedShipping = input.pincode
    ? await resolveShipping({
        pincode: input.pincode,
        parcel: cart.parcel,
        orderValue: netItemsTotal,
        preferredCourierId: input.courierId,
      })
    : { ...NO_SHIPPING, amount: shippingFee(netItemsTotal) };

  const shipping = coupon?.freeShipping ? { ...quotedShipping, amount: 0 } : quotedShipping;

  const tax = computeTax({
    lines: cart.lines.map((line, index) => ({
      productId: line.productId,
      gross: netLineGross[index],
      rate: line.gstRate,
    })),
    shippingGross: shipping.amount,
    buyerState: input.state ?? null,
  });

  return {
    cart,
    shipping,
    tax,
    coupon,
    couponError,
    itemsTotal: cart.itemsTotal,
    discountTotal,
    shippingAmount: shipping.amount,
    totalAmount: round2(netItemsTotal + shipping.amount),
    netLineGross,
  };
}

/** The money-shaped part of a quote, safe to hand to a browser. */
export function serializeQuote(quote: Quote) {
  return {
    itemsTotal: quote.itemsTotal,
    discountTotal: quote.discountTotal,
    shippingAmount: quote.shippingAmount,
    totalAmount: quote.totalAmount,
    courierId: quote.shipping.courierId,
    courierName: quote.shipping.courierName,
    coupon: quote.coupon
      ? {
          code: quote.coupon.code,
          type: quote.coupon.type,
          description: quote.coupon.description,
          discount: quote.coupon.discount,
          freeShipping: quote.coupon.freeShipping,
        }
      : null,
    couponError: quote.couponError,
    tax: {
      enabled: quote.tax.enabled,
      total: quote.tax.taxTotal,
      cgst: quote.tax.cgstTotal,
      sgst: quote.tax.sgstTotal,
      igst: quote.tax.igstTotal,
      intraState: quote.tax.intraState,
      buckets: quote.tax.buckets,
    },
  };
}
