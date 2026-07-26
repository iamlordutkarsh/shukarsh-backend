export function serializeOrder(order: any) {
  const { user, shipment, ...rest } = order;

  return {
    ...rest,
    itemsTotal: Number(order.itemsTotal ?? 0),
    shippingAmount: Number(order.shippingAmount ?? 0),
    totalAmount: Number(order.totalAmount),
    customerEmail: order.email ?? user?.email ?? null,
    customerName:
      order.customerName ?? ([user?.firstName, user?.lastName].filter(Boolean).join(" ") || null),
    items: (order.items ?? []).map((item: any) => ({ ...item, price: Number(item.price) })),
    shipment: shipment
      ? {
          ...shipment,
          appliedWeightKg: shipment.appliedWeightKg != null ? Number(shipment.appliedWeightKg) : null,
        }
      : null,
  };
}
