import { prisma } from "./prisma";
import { NotEnoughStockError, moveStock } from "./inventory";

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
export async function applyOrderStatus(
  orderId: string,
  nextStatus: string,
  options?: {
    /**
     * The caller has already moved the stock itself, unit by unit. A return puts
     * back only what came back and only what can be sold again, which is a finer
     * decision than "the whole order is off". The shelf is left alone, but the
     * order is still marked as no longer holding stock so a later close cannot
     * put the same units back twice.
     */
    stockHandledElsewhere?: boolean;
  }
): Promise<StatusChange | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!current) return null;

    const paid = current.paymentStatus === "PAID";
    const closing = nextStatus === "CANCELLED" || nextStatus === "RETURNED";
    const released = paid && closing && !current.stockReleased;
    const reserved = paid && !closing && current.stockReleased;
    const shelfMoves = !options?.stockHandledElsewhere;

    for (const item of shelfMoves ? current.items : []) {
      if (released) {
        await moveStock(tx, {
          productId: item.productId,
          delta: item.quantity,
          reason: nextStatus === "RETURNED" ? "RETURN_RESTOCK" : "CANCELLATION",
          orderId: current.id,
        });
      } else if (reserved) {
        try {
          // Conditional, which moveStock is by default, so a reopen can never
          // drive the catalogue negative and promise units to both this customer
          // and whoever bought them since.
          await moveStock(tx, {
            productId: item.productId,
            delta: -item.quantity,
            reason: "REOPEN",
            orderId: current.id,
          });
        } catch (error) {
          if (error instanceof NotEnoughStockError) {
            throw new InsufficientStockError(item.productId);
          }
          throw error;
        }
      }
    }

    // Written the first time only. A replayed Delivered scan, or an admin
    // walking an order back and forward again, must not restart the customer's
    // window to ask for a return.
    const delivered = nextStatus === "DELIVERED" && !current.deliveredAt;

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: nextStatus as never,
        ...(released ? { stockReleased: true } : {}),
        ...(reserved ? { stockReleased: false } : {}),
        ...(delivered ? { deliveredAt: new Date() } : {}),
      },
    });

    return { released, reserved };
  });
}
