import { returnEligibility, serializeReturn } from "./returns";

/** Only what an order line needs to name the thing that was bought. Never the
 *  whole product row: an include that pulled one in would carry costPrice. */
function serializeLineProduct(product: any) {
  if (!product) return null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    images: product.images ?? [],
    // Required on a tax invoice line. Null where the catalogue predates it, and
    // the invoice prints a dash rather than inventing one.
    hsn: product.hsn ?? null,
  };
}

function serializeShipment(shipment: any) {
  if (!shipment) return null;

  return {
    id: shipment.id,
    orderId: shipment.orderId,
    provider: shipment.provider,
    providerOrderId: shipment.providerOrderId,
    providerShipmentId: shipment.providerShipmentId,
    providerReference: shipment.providerReference,
    awb: shipment.awb,
    courierId: shipment.courierId,
    courierName: shipment.courierName,
    labelUrl: shipment.labelUrl,
    invoiceUrl: shipment.invoiceUrl,
    manifestUrl: shipment.manifestUrl,
    trackingUrl: shipment.trackingUrl,
    status: shipment.status,
    statusCode: shipment.statusCode,
    appliedWeightKg: shipment.appliedWeightKg != null ? Number(shipment.appliedWeightKg) : null,
    pickupScheduledAt: shipment.pickupScheduledAt,
    pickupToken: shipment.pickupToken,
    lastSyncedAt: shipment.lastSyncedAt,
  };
}

/**
 * Turns an order row into something safe to send out.
 *
 * Customers read their own orders through the same endpoints the admin panel
 * uses, so this names the fields that may leave rather than the ones that may
 * not. What a line cost us is the field that must not slip through, and naming
 * it to strip it means the next private column added to Order or Product ships
 * to customers until somebody notices. Cost stays opt-in: a caller that forgets
 * the flag shows a customer too little, not too much.
 */
export function serializeOrder(order: any, options?: { includeCost?: boolean }) {
  const user = order.user;

  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    itemsTotal: Number(order.itemsTotal ?? 0),
    shippingAmount: Number(order.shippingAmount ?? 0),
    codFee: Number(order.codFee ?? 0),
    discountTotal: Number(order.discountTotal ?? 0),
    couponCode: order.couponCode ?? null,
    totalAmount: Number(order.totalAmount),
    taxTotal: Number(order.taxTotal ?? 0),
    cgstTotal: Number(order.cgstTotal ?? 0),
    sgstTotal: Number(order.sgstTotal ?? 0),
    igstTotal: Number(order.igstTotal ?? 0),
    placeOfSupply: order.placeOfSupply ?? null,
    invoiceNumber: order.invoiceNumber ?? null,
    invoicedAt: order.invoicedAt ?? null,
    courierId: order.courierId ?? null,
    courierName: order.courierName ?? null,
    shippingAddress: order.shippingAddress ?? null,
    razorpayOrderId: order.razorpayOrderId ?? null,
    razorpayPaymentId: order.razorpayPaymentId ?? null,
    customerEmail: order.email ?? user?.email ?? null,
    customerName:
      order.customerName ?? ([user?.firstName, user?.lastName].filter(Boolean).join(" ") || null),
    customerPhone: order.customerPhone ?? null,
    deliveredAt: order.deliveredAt ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: (order.items ?? []).map((item: any) => ({
      id: item.id,
      orderId: item.orderId,
      productId: item.productId,
      // The snapshot, not the linked row: what was bought, even if that colour
      // or size has since been renamed or withdrawn.
      variantLabel: item.variantLabel ?? null,
      variantColour: item.variantColour ?? null,
      quantity: item.quantity,
      price: Number(item.price),
      gstRate: Number(item.gstRate ?? 0),
      taxableAmount: Number(item.taxableAmount ?? 0),
      taxAmount: Number(item.taxAmount ?? 0),
      product: serializeLineProduct(item.product),
      ...(options?.includeCost
        ? { costPrice: item.costPrice != null ? Number(item.costPrice) : null }
        : {}),
    })),
    shipment: serializeShipment(order.shipment),
    returns: (order.returns ?? []).map(serializeReturn),
    // Only when the relation was actually loaded. Eligibility is decided partly
    // by the returns already on the order, so an include that left them out
    // would produce a confident wrong answer rather than no answer.
    ...(Array.isArray(order.returns) ? { returnWindow: returnEligibility(order) } : {}),
  };
}
