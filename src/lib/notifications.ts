import { prisma } from "./prisma";
import { isEmailConfigured, sendEmail } from "./mailer";

const STORE = "Shukarsh";

function storeUrl(): string {
  return (process.env.FRONTEND_URL || "https://shukarsh.com").replace(/\/$/, "");
}

function money(value: unknown): string {
  return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function reference(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

function layout(heading: string, intro: string, body: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#faf7ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2c2440">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8b6bff;font-weight:700">${STORE}</p>
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.3">${heading}</h1>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6b6480">${intro}</p>
    ${body}
    <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#9a94ad">
      Questions? Just reply to this email and a human will get back to you.
    </p>
  </div>
</body></html>`;
}

function itemRows(items: { quantity: number; price: unknown; product: { name: string } }[]): string {
  return items
    .map(
      (item) => `<tr>
        <td style="padding:8px 0;font-size:14px">${escapeHtml(item.product.name)}
          <span style="color:#9a94ad"> × ${item.quantity}</span></td>
        <td style="padding:8px 0;font-size:14px;text-align:right;font-weight:600">${money(
          Number(item.price) * item.quantity
        )}</td>
      </tr>`
    )
    .join("");
}

function totalsRows(order: {
  itemsTotal: unknown;
  shippingAmount: unknown;
  totalAmount: unknown;
  discountTotal?: unknown;
  couponCode?: string | null;
  taxTotal?: unknown;
  cgstTotal?: unknown;
  sgstTotal?: unknown;
  igstTotal?: unknown;
}): string {
  const shipping = Number(order.shippingAmount ?? 0);
  const tax = Number(order.taxTotal ?? 0);
  const cgst = Number(order.cgstTotal ?? 0);
  const sgst = Number(order.sgstTotal ?? 0);
  const igst = Number(order.igstTotal ?? 0);

  // Prices are MRP, so GST sits under the total as a disclosure rather than
  // above it as a charge.
  const taxRow =
    tax > 0
      ? `<tr><td colspan="2" style="padding:6px 0 0;font-size:12px;color:#9a94ad">
           Includes GST ${money(tax)}${
             igst > 0 ? ` (IGST)` : cgst > 0 ? ` (CGST ${money(cgst)} + SGST ${money(sgst)})` : ""
           }
         </td></tr>`
      : "";

  const discount = Number(order.discountTotal ?? 0);
  const discountRow =
    discount > 0
      ? `<tr><td style="padding:4px 0;font-size:14px;color:#3fb98f">Discount${
          order.couponCode ? ` (${escapeHtml(order.couponCode)})` : ""
        }</td>
          <td style="padding:4px 0;font-size:14px;text-align:right;color:#3fb98f">−${money(discount)}</td></tr>`
      : "";

  return `<tr><td style="padding:10px 0 0;font-size:14px;color:#6b6480;border-top:1px solid #eee8ff">Items</td>
      <td style="padding:10px 0 0;font-size:14px;text-align:right;border-top:1px solid #eee8ff">${money(order.itemsTotal)}</td></tr>
    ${discountRow}
    <tr><td style="padding:4px 0;font-size:14px;color:#6b6480">Shipping</td>
      <td style="padding:4px 0;font-size:14px;text-align:right">${shipping > 0 ? money(shipping) : "Free"}</td></tr>
    <tr><td style="padding:10px 0 0;font-size:16px;font-weight:700;border-top:1px solid #eee8ff">Total</td>
      <td style="padding:10px 0 0;font-size:16px;text-align:right;font-weight:700;border-top:1px solid #eee8ff">${money(
        order.totalAmount
      )}</td></tr>
    ${taxRow}`;
}

async function loadOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { email: true } },
      shipment: true,
      items: { include: { product: { select: { name: true } } } },
    },
  });
}

function recipientOf(order: { email: string | null; user: { email: string } | null }): string | null {
  return order.email ?? order.user?.email ?? null;
}

/** Receipt sent the moment a payment is confirmed, from either path. */
export async function sendOrderConfirmation(orderId: string): Promise<void> {
  if (!isEmailConfigured()) return;

  try {
    const order = await loadOrder(orderId);
    if (!order) return;

    const to = recipientOf(order);
    if (!to) return;

    const address = (order.shippingAddress ?? {}) as Record<string, string>;
    const lines = [address.line1, address.line2, address.city, address.state, address.zip]
      .filter(Boolean)
      .join(", ");

    await sendEmail({
      to,
      subject: `Order ${reference(order.id)} confirmed`,
      html: layout(
        "Thank you, your order is confirmed",
        `We have your payment and are getting order <strong>${reference(
          order.id
        )}</strong> ready. You will hear from us again the moment it ships.`,
        `<table style="width:100%;border-collapse:collapse">
           ${itemRows(order.items)}
           ${totalsRows(order)}
         </table>
         ${
           lines
             ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b6480">
                  <strong style="color:#2c2440">Delivering to</strong><br>${escapeHtml(
                    order.customerName ?? ""
                  )}<br>${escapeHtml(lines)}
                </p>`
             : ""
         }
         <p style="margin:24px 0 0"><a href="${storeUrl()}/profile#orders"
            style="display:inline-block;padding:12px 24px;border-radius:999px;background:#8b6bff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Track this order</a></p>`
      ),
    });
  } catch (error) {
    console.error("Order confirmation email failed:", error);
  }
}

/** Dispatch notice with the AWB, sent once a shipment has one. */
export async function sendDispatchNotice(orderId: string): Promise<void> {
  if (!isEmailConfigured()) return;

  try {
    const order = await loadOrder(orderId);
    if (!order?.shipment?.awb) return;

    const to = recipientOf(order);
    if (!to) return;

    const { awb, courierName, trackingUrl } = order.shipment;

    await sendEmail({
      to,
      subject: `Order ${reference(order.id)} is on its way`,
      html: layout(
        "Your order has shipped",
        `Order <strong>${reference(order.id)}</strong> left us today${
          courierName ? ` with ${escapeHtml(courierName)}` : ""
        }.`,
        `<table style="width:100%;border-collapse:collapse">
           <tr><td style="padding:4px 0;font-size:14px;color:#6b6480">Tracking number</td>
             <td style="padding:4px 0;font-size:14px;text-align:right;font-weight:600">${escapeHtml(awb)}</td></tr>
           ${
             courierName
               ? `<tr><td style="padding:4px 0;font-size:14px;color:#6b6480">Courier</td>
                    <td style="padding:4px 0;font-size:14px;text-align:right">${escapeHtml(courierName)}</td></tr>`
               : ""
           }
         </table>
         <p style="margin:24px 0 0"><a href="${trackingUrl ?? `${storeUrl()}/profile#orders`}"
            style="display:inline-block;padding:12px 24px;border-radius:999px;background:#8b6bff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Track your parcel</a></p>`
      ),
    });
  } catch (error) {
    console.error("Dispatch email failed:", error);
  }
}
