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
