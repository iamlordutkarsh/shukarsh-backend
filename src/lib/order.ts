export function serializeOrder(order: any) {
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
    items: (order.items ?? []).map((item: any) => ({
      ...item,
      price: Number(item.price),
      gstRate: Number(item.gstRate ?? 0),
      taxableAmount: Number(item.taxableAmount ?? 0),
      taxAmount: Number(item.taxAmount ?? 0),
    })),
    shipment: shipment
      ? {
          ...shipment,
          appliedWeightKg: shipment.appliedWeightKg != null ? Number(shipment.appliedWeightKg) : null,
        }
      : null,
  };
}
