/**
 * Turns an order row into something safe to send out.
 *
 * Customers read their own orders through the same endpoints the admin panel
 * uses, so what a line item costs us has to be dropped unless the caller is an
 * admin. Like serializeProduct, cost is opt-in rather than opt-out: forgetting
 * the flag shows a customer too little, not too much.
 */
export function serializeOrder(order: any, options?: { includeCost?: boolean }) {
  const { user, shipment, ...rest } = order;

  return {
    ...rest,
    itemsTotal: Number(order.itemsTotal ?? 0),
    shippingAmount: Number(order.shippingAmount ?? 0),
    discountTotal: Number(order.discountTotal ?? 0),
    totalAmount: Number(order.totalAmount),
    taxTotal: Number(order.taxTotal ?? 0),
    cgstTotal: Number(order.cgstTotal ?? 0),
    sgstTotal: Number(order.sgstTotal ?? 0),
    igstTotal: Number(order.igstTotal ?? 0),
    customerEmail: order.email ?? user?.email ?? null,
    customerName:
      order.customerName ?? ([user?.firstName, user?.lastName].filter(Boolean).join(" ") || null),
    items: (order.items ?? []).map((item: any) => {
      const { costPrice, ...line } = item;

      return {
        ...line,
        price: Number(item.price),
        gstRate: Number(item.gstRate ?? 0),
        taxableAmount: Number(item.taxableAmount ?? 0),
        taxAmount: Number(item.taxAmount ?? 0),
        ...(options?.includeCost
          ? { costPrice: costPrice != null ? Number(costPrice) : null }
          : {}),
      };
    }),
    shipment: shipment
      ? {
          ...shipment,
          appliedWeightKg: shipment.appliedWeightKg != null ? Number(shipment.appliedWeightKg) : null,
        }
      : null,
  };
}
