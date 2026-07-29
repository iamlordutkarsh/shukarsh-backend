import { round2 } from "./tax";

const DEFAULT_WINDOW_DAYS = 7;

/** Requests that still have a claim on the goods. */
const LIVE_STATUSES = ["REQUESTED", "APPROVED", "RECEIVED", "COMPLETED"] as const;

/** Requests waiting on us to do something. */
const OPEN_STATUSES = ["REQUESTED", "APPROVED", "RECEIVED"] as const;

/** Photos one request may carry. Enough to show a crack from two angles. */
export const RETURN_PHOTO_LIMIT = 4;

/**
 * Whether this reason has to come with a picture.
 *
 * Damage is a claim about the state of the goods and a photo is the only thing
 * that settles it without a letter each way. A wrong item is self-evident from
 * whatever comes back, so a picture is welcome there but not demanded.
 */
export function photoRequired(reason: string): boolean {
  return reason === "DAMAGED";
}

export type ReturnBlock =
  | "NOT_PAID"
  | "NOT_DELIVERED"
  | "NO_DELIVERY_DATE"
  | "WINDOW_CLOSED"
  | "ALREADY_OPEN"
  | "NOTHING_LEFT";

/**
 * Days after delivery a return can be asked for. The product page promises a
 * week, so moving this means moving that copy too.
 */
export function returnWindowDays(): number {
  const raw = Number(process.env.RETURN_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WINDOW_DAYS;
}

export function returnWindowClosesAt(deliveredAt: Date | null | undefined): Date | null {
  if (!deliveredAt) return null;
  const closes = new Date(deliveredAt);
  closes.setDate(closes.getDate() + returnWindowDays());
  return closes;
}

/** What to tell the customer when the button is not there. */
export function returnBlockMessage(block: ReturnBlock): string {
  switch (block) {
    case "NOT_PAID":
      return "This order was never paid for, so there is nothing to send back.";
    case "NOT_DELIVERED":
      return "This order has not arrived yet. Once it does you will have a week to tell us if something is wrong.";
    case "NO_DELIVERY_DATE":
      return "We do not have a delivery date on record for this order. Write to us and we will sort it out by hand.";
    case "WINDOW_CLOSED":
      return `Returns close ${returnWindowDays()} days after delivery, and that has passed. Write to us anyway if something is badly wrong.`;
    case "ALREADY_OPEN":
      return "You already have a return open on this order. We will come back to you on that one first.";
    case "NOTHING_LEFT":
      return "Everything on this order has already been returned.";
  }
}

/**
 * How many units of each line are still available to claim.
 *
 * A rejected or withdrawn request releases its units; every other state keeps
 * hold of them, so a second request cannot claim the same dress twice.
 */
export function returnableQuantities(order: any): Map<string, number> {
  const claimed = new Map<string, number>();

  for (const request of order.returns ?? []) {
    if (!LIVE_STATUSES.includes(request.status)) continue;
    for (const item of request.items ?? []) {
      claimed.set(item.orderItemId, (claimed.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }

  const available = new Map<string, number>();
  for (const item of order.items ?? []) {
    available.set(item.id, Math.max(0, item.quantity - (claimed.get(item.id) ?? 0)));
  }

  return available;
}

export interface ReturnEligibility {
  open: boolean;
  block: ReturnBlock | null;
  closesAt: Date | null;
  /** Units still claimable, keyed by order item id. */
  available: Record<string, number>;
}

/**
 * Whether this order can have a return raised against it right now.
 *
 * Delivery is the gate rather than dispatch: while a parcel is still moving the
 * customer can refuse it at the door, which is the courier's job and not ours.
 */
export function returnEligibility(order: any): ReturnEligibility {
  const closesAt = returnWindowClosesAt(order.deliveredAt);
  const available = returnableQuantities(order);
  const asRecord = Object.fromEntries(available);

  const decide = (): ReturnBlock | null => {
    if (order.paymentStatus !== "PAID") return "NOT_PAID";
    if (order.status !== "DELIVERED") return "NOT_DELIVERED";
    // Orders delivered before we started recording the date have no window to
    // count, so they go through a human rather than being refused outright.
    if (!closesAt) return "NO_DELIVERY_DATE";
    if (closesAt.getTime() < Date.now()) return "WINDOW_CLOSED";
    if ((order.returns ?? []).some((request: any) => OPEN_STATUSES.includes(request.status))) {
      return "ALREADY_OPEN";
    }
    if (![...available.values()].some((units) => units > 0)) return "NOTHING_LEFT";
    return null;
  };

  const block = decide();
  return { open: block === null, block, closesAt, available: asRecord };
}

/**
 * What the customer actually paid for one line: discount already taken off, GST
 * already inside.
 *
 * computeTax derives the taxable value by subtracting the tax from the gross it
 * was handed, and the gross it is handed is the line after its share of the
 * coupon. So these two columns add back up to the money that changed hands for
 * this line, which is a truer figure than re-apportioning the discount here and
 * hoping the arithmetic matches.
 */
function paidForLine(item: any, order: any): number {
  const stored = Number(item.taxableAmount ?? 0) + Number(item.taxAmount ?? 0);
  if (stored > 0) return round2(stored);

  // Orders placed before those columns existed carry zeroes. Apportion by value,
  // which is what the coupon did on the way in.
  const gross = Number(item.price) * item.quantity;
  const itemsTotal = Number(order.itemsTotal ?? 0);
  const discount = Number(order.discountTotal ?? 0);
  if (itemsTotal <= 0) return round2(gross);

  return round2(gross - discount * (gross / itemsTotal));
}

export interface RefundLine {
  orderItemId: string;
  quantity: number;
}

export interface RefundBreakdown {
  /** Goods only. */
  itemsAmount: number;
  /** Delivery, refunded only when the whole order is going back. */
  shippingAmount: number;
  total: number;
  lines: { orderItemId: string; quantity: number; amount: number }[];
}

/**
 * What a return is worth.
 *
 * Refunding the sticker price would hand back more than was taken whenever a
 * coupon was used: three dresses with ₹200 off the bag and one coming back is
 * not worth a third of the discount to us and the whole dress to the customer.
 * Delivery only comes back when nothing is being kept, since we paid the
 * courier either way.
 */
export function refundBreakdown(order: any, requested: RefundLine[]): RefundBreakdown {
  const byId = new Map<string, any>((order.items ?? []).map((item: any) => [item.id, item]));
  const lines: RefundBreakdown["lines"] = [];
  let itemsAmount = 0;

  for (const line of requested) {
    const item = byId.get(line.orderItemId);
    if (!item || line.quantity <= 0) continue;

    const units = Math.min(line.quantity, item.quantity);
    const paid = paidForLine(item, order);
    // Whole lines settle exactly; part of a line splits what was paid evenly,
    // which is the only defensible split when a discount covered the bag.
    const amount = units === item.quantity ? paid : round2((paid / item.quantity) * units);

    lines.push({ orderItemId: item.id, quantity: units, amount });
    itemsAmount = round2(itemsAmount + amount);
  }

  const everythingBack = (order.items ?? []).every((item: any) => {
    const asked = lines.find((line) => line.orderItemId === item.id);
    return asked?.quantity === item.quantity;
  });

  const shippingAmount = everythingBack ? round2(Number(order.shippingAmount ?? 0)) : 0;

  return {
    itemsAmount,
    shippingAmount,
    total: round2(itemsAmount + shippingAmount),
    lines,
  };
}

/** Which decisions each state allows. Anything absent is terminal. */
const TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["RECEIVED"],
  RECEIVED: ["COMPLETED"],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Everything serializeReturn reads, so the two cannot drift apart. */
export const returnInclude = {
  items: {
    include: {
      orderItem: {
        include: { product: { select: { id: true, name: true, slug: true, images: true } } },
      },
    },
  },
} as const;

export function serializeReturn(request: any) {
  return {
    id: request.id,
    orderId: request.orderId,
    reason: request.reason,
    outcome: request.outcome,
    status: request.status,
    customerNote: request.customerNote,
    photos: request.photos ?? [],
    adminNote: request.adminNote ?? null,
    refundAmount: request.refundAmount != null ? Number(request.refundAmount) : null,
    refundedAt: request.refundedAt ?? null,
    refundStatus: request.refundStatus ?? null,
    items: (request.items ?? []).map((item: any) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      quantity: item.quantity,
      resellable: item.resellable ?? null,
      product: item.orderItem?.product
        ? {
            id: item.orderItem.product.id,
            name: item.orderItem.product.name,
            slug: item.orderItem.product.slug,
            images: item.orderItem.product.images ?? [],
          }
        : null,
    })),
    decidedAt: request.decidedAt ?? null,
    receivedAt: request.receivedAt ?? null,
    completedAt: request.completedAt ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

/**
 * The queue view. Carries the order context a decision needs, including the
 * payment id: until refunds are automated, that is what someone types into the
 * Razorpay dashboard to send the money back.
 */
export function serializeAdminReturn(request: any) {
  const order = request.order ?? {};
  const proposed = refundBreakdown(
    order,
    (request.items ?? []).map((item: any) => ({
      orderItemId: item.orderItemId,
      quantity: item.quantity,
    }))
  );

  return {
    ...serializeReturn(request),
    /** What it would be worth if decided now. refundAmount is the frozen figure. */
    proposedRefund: proposed.total,
    /** Razorpay's reference, and why the last attempt failed. Staff only. */
    refundId: request.refundId ?? null,
    refundError: request.refundError ?? null,
    order: {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      totalAmount: Number(order.totalAmount ?? 0),
      deliveredAt: order.deliveredAt ?? null,
      customerName: order.customerName ?? null,
      customerEmail: order.email ?? order.user?.email ?? null,
      customerPhone: order.customerPhone ?? null,
      razorpayPaymentId: order.razorpayPaymentId ?? null,
    },
  };
}
