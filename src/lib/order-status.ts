import { prisma } from "./prisma";

/** How far along the fulfilment path each status sits. */
const RANK: Record<string, number> = {
  PENDING: 0,
  PROCESSING: 1,
  SHIPPED: 2,
  DELIVERED: 3,
};

/**
 * Decides whether a courier update should change our order status, and returns
 * the new one or null to leave it alone.
 *
 * Couriers replay scans and deliver them out of order, so a naive assignment
 * can walk an order backwards from Shipped to Processing hours after dispatch.
 * A cancellation or return recorded by a human is also final: a late scan must
 * not quietly reopen it.
 */
export function nextOrderStatus(current: string, fromCourier: string | null | undefined): string | null {
  if (!fromCourier || fromCourier === current) return null;
  if (current === "CANCELLED" || current === "RETURNED") return null;

  // A parcel coming back or refused is news regardless of where we thought it was.
  if (fromCourier === "RETURNED" || fromCourier === "CANCELLED") return fromCourier;

  const from = RANK[current];
  const to = RANK[fromCourier];
  if (from === undefined || to === undefined) return null;

  return to > from ? fromCourier : null;
}

/** Thrown when reopening an order would take stock the catalogue does not have. */
export class InsufficientStockError extends Error {
  productId: string;

  constructor(productId: string) {
    super("Not enough stock to reopen this order");
    this.name = "InsufficientStockError";
    this.productId = productId;
  }
}

export interface StatusChange {
  released: boolean;
  reserved: boolean;
}

/**
 * Writes a new order status together with the stock it moves.
 *
 * Closing a paid order puts its units back on the shelf; reopening one takes
 * them again, or the catalogue would keep counting stock that is still owed.
 * Every path that changes a status has to go through here, including the ones
 * a courier drives, or a returned parcel is never added back to the catalogue.
 *
 * Returns null when the order has gone, or the bookkeeping that was applied.
 */
export async function applyOrderStatus(orderId: string, nextStatus: string): Promise<StatusChange | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!current) return null;

    const paid = current.paymentStatus === "PAID";
    const closing = nextStatus === "CANCELLED" || nextStatus === "RETURNED";
    const released = paid && closing && !current.stockReleased;
    const reserved = paid && !closing && current.stockReleased;

    for (const item of current.items) {
      if (released) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      } else if (reserved) {
        // Conditional so a reopen can never drive the catalogue negative and
        // promise units to both this customer and whoever bought them since.
        const taken = await tx.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });

        if (taken.count === 0) throw new InsufficientStockError(item.productId);
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: nextStatus as never,
        ...(released ? { stockReleased: true } : {}),
        ...(reserved ? { stockReleased: false } : {}),
      },
    });

    return { released, reserved };
  });
}
