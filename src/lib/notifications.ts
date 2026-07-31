import { prisma } from "./prisma";
import { isEmailConfigured, sendEmail } from "./mailer";
import { recoveryPath } from "./cart-recovery";

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
  codFee?: unknown;
}): string {
  const shipping = Number(order.shippingAmount ?? 0);
  const codFee = Number(order.codFee ?? 0);
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

  // Itemised rather than folded into the total, because a customer counting out
  // cash at the door should be able to see where every rupee came from.
  const codRow =
    codFee > 0
      ? `<tr><td style="padding:4px 0;font-size:14px;color:#6b6480">Cash collection</td>
          <td style="padding:4px 0;font-size:14px;text-align:right">${money(codFee)}</td></tr>`
      : "";

  return `<tr><td style="padding:10px 0 0;font-size:14px;color:#6b6480;border-top:1px solid #eee8ff">Items</td>
      <td style="padding:10px 0 0;font-size:14px;text-align:right;border-top:1px solid #eee8ff">${money(order.itemsTotal)}</td></tr>
    ${discountRow}
    <tr><td style="padding:4px 0;font-size:14px;color:#6b6480">Shipping</td>
      <td style="padding:4px 0;font-size:14px;text-align:right">${shipping > 0 ? money(shipping) : "Free"}</td></tr>
    ${codRow}
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

/** Where a copy of anything the shop has to act on goes. */
function shopInbox(): string | null {
  return process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM || null;
}

async function loadReturn(returnId: string) {
  return prisma.returnRequest.findUnique({
    where: { id: returnId },
    include: {
      order: { include: { user: { select: { email: true } } } },
      items: { include: { orderItem: { include: { product: { select: { name: true } } } } } },
    },
  });
}

const REASON_LABEL: Record<string, string> = {
  DAMAGED: "arrived damaged",
  WRONG_ITEM: "was the wrong item",
};

const OUTCOME_LABEL: Record<string, string> = {
  REFUND: "a refund",
  EXCHANGE: "a replacement",
};

function returnRows(items: { quantity: number; orderItem: { product: { name: string } } }[]): string {
  return items
    .map(
      (item) => `<tr><td style="padding:8px 0;font-size:14px">${escapeHtml(
        item.orderItem.product.name
      )}<span style="color:#9a94ad"> × ${item.quantity}</span></td></tr>`
    )
    .join("");
}

/**
 * The photos, small, as links.
 *
 * Plenty of mail clients refuse remote images until you ask them to, so each one
 * is wrapped in a link to itself: the thumbnail when images load, a clickable
 * line when they do not.
 */
function photoBlock(photos: string[]): string {
  if (photos.length === 0) return "";

  const thumbs = photos
    .map(
      (url, index) =>
        `<a href="${escapeHtml(url)}" style="text-decoration:none;margin:0 8px 8px 0;display:inline-block">
           <img src="${escapeHtml(url)}" alt="Photo ${index + 1}" width="96" height="96"
                style="width:96px;height:96px;object-fit:cover;border-radius:10px;border:1px solid #e8e4f2;display:block">
         </a>`
    )
    .join("");

  return `<p style="margin:20px 0 8px;font-size:13px;color:#6b6480"><strong style="color:#2c2440">What they sent</strong></p>
    <div>${thumbs}</div>`;
}

function noteBlock(label: string, note: string): string {
  return `<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6b6480">
    <strong style="color:#2c2440">${label}</strong><br>${escapeHtml(note)}</p>`;
}

/** Acknowledges a return the moment it is asked for, and tells the shop. */
export async function sendReturnRequested(returnId: string): Promise<void> {
  if (!isEmailConfigured()) return;

  try {
    const request = await loadReturn(returnId);
    if (!request) return;

    const ref = reference(request.orderId);
    const items = returnRows(request.items);
    const asked = OUTCOME_LABEL[request.outcome] ?? "a refund";
    const because = REASON_LABEL[request.reason] ?? "was not right";
    const to = recipientOf(request.order);

    if (to) {
      await sendEmail({
        to,
        subject: `We have your return request for order ${ref}`,
        html: layout(
          "Thank you, we are on it",
          `You have asked us for ${asked} on order <strong>${ref}</strong> because it ${because}. Someone will look at this and write back, usually within a day.`,
          `<table style="width:100%;border-collapse:collapse">${items}</table>
           ${noteBlock("What you told us", request.customerNote)}`
        ),
      });
    }

    const shop = shopInbox();
    if (shop) {
      await sendEmail({
        to: shop,
        subject: `Return requested on order ${ref}`,
        html: layout(
          "A return is waiting on you",
          `Order <strong>${ref}</strong>: the customer wants ${asked} because it ${because}.`,
          `<table style="width:100%;border-collapse:collapse">${items}</table>
           ${noteBlock("Their words", request.customerNote)}
           ${photoBlock(request.photos ?? [])}
           <p style="margin:24px 0 0"><a href="${storeUrl()}/admin/returns"
              style="display:inline-block;padding:12px 24px;border-radius:999px;background:#8b6bff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Open the returns queue</a></p>`
        ),
      });
    }
  } catch (error) {
    console.error("Return request email failed:", error);
  }
}

/** Tells the customer we accepted or refused, and why. */
export async function sendReturnDecision(returnId: string): Promise<void> {
  if (!isEmailConfigured()) return;

  try {
    const request = await loadReturn(returnId);
    if (!request) return;

    const to = recipientOf(request.order);
    if (!to) return;

    const ref = reference(request.orderId);
    const approved = request.status === "APPROVED";
    const asked = OUTCOME_LABEL[request.outcome] ?? "a refund";

    await sendEmail({
      to,
      subject: approved
        ? `Your return for order ${ref} is approved`
        : `About your return for order ${ref}`,
      html: layout(
        approved ? "Your return is approved" : "We cannot take this one back",
        approved
          ? `We will arrange a pickup for order <strong>${ref}</strong> and email you the details. Once the parcel is back with us, ${asked} follows.`
          : `We have looked at your request on order <strong>${ref}</strong> and cannot accept it.`,
        `<table style="width:100%;border-collapse:collapse">${returnRows(request.items)}</table>
         ${request.adminNote ? noteBlock("Why", request.adminNote) : ""}`
      ),
    });
  } catch (error) {
    console.error("Return decision email failed:", error);
  }
}

/** Closes the loop once the money is back or a replacement is on its way. */
export async function sendReturnCompleted(returnId: string): Promise<void> {
  if (!isEmailConfigured()) return;

  try {
    const request = await loadReturn(returnId);
    if (!request) return;

    const to = recipientOf(request.order);
    if (!to) return;

    const ref = reference(request.orderId);
    const refunded = request.outcome === "REFUND";
    const amount = request.refundAmount != null ? money(request.refundAmount) : null;

    await sendEmail({
      to,
      subject: refunded ? `Refund sent for order ${ref}` : `Replacement on its way for order ${ref}`,
      html: layout(
        refunded ? "Your refund is on its way" : "Your replacement is on its way",
        refunded
          ? `We have refunded ${
              amount ? `<strong>${amount}</strong>` : "your return"
            } against order <strong>${ref}</strong>. Banks take a few working days to show it, and it goes back to the card or account you paid with.`
          : `A replacement for order <strong>${ref}</strong> is being packed. You will get tracking as soon as it leaves us.`,
        `<table style="width:100%;border-collapse:collapse">${returnRows(request.items)}</table>
         ${request.adminNote ? noteBlock("Note from us", request.adminNote) : ""}
         ${
           refunded && request.refundId
             ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#9a94ad">
                  Reference <strong style="color:#2c2440">${escapeHtml(request.refundId)}</strong>.
                  Quote it to your bank if the money has not appeared within seven working days.
                </p>`
             : ""
         }`
      ),
    });
  } catch (error) {
    console.error("Return completion email failed:", error);
  }
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
        // A cash order has no payment yet, and telling someone we have their
        // money when we do not is the one line in this email that must be right.
        order.paymentMethod === "COD"
          ? `We are getting order <strong>${reference(order.id)}</strong> ready. Please keep
             <strong>${money(order.totalAmount)}</strong> in cash ready for the courier, who
             often cannot give change. You will hear from us again the moment it ships.`
          : `We have your payment and are getting order <strong>${reference(
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

/**
 * One nudge for a checkout that was never paid for.
 *
 * Returns whether anything was sent, because the caller records the attempt and
 * must not mark an order as reminded when no reminder went anywhere. Deliberately
 * plain: no discount, no countdown, no second try. The commonest reason a checkout
 * is abandoned is a card that would not go through, and the fix for that is a
 * working link back, not pressure.
 */
export async function sendCartRecovery(orderId: string): Promise<boolean> {
  if (!isEmailConfigured()) return false;

  const path = recoveryPath(orderId);
  if (!path) return false;

  try {
    const order = await loadOrder(orderId);
    if (!order || order.items.length === 0) return false;

    const to = recipientOf(order);
    if (!to) return false;

    const firstName = (order.customerName ?? "").trim().split(/\s+/)[0];

    await sendEmail({
      to,
      subject: "You left something behind",
      html: layout(
        firstName ? `${escapeHtml(firstName)}, your bag is still here` : "Your bag is still here",
        "We kept hold of what you picked out. One tap puts it back in your bag, and nothing is charged until you check out.",
        `<table style="width:100%;border-collapse:collapse">
           ${itemRows(order.items)}
         </table>
         <p style="margin:24px 0 0"><a href="${storeUrl()}${path}"
            style="display:inline-block;padding:12px 24px;border-radius:999px;background:#8b6bff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Put it back in my bag</a></p>
         <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#9a94ad">
           Prices and delivery are worked out fresh when you check out, so nothing here is held at yesterday's rate.
         </p>`
      ),
    });

    return true;
  } catch (error) {
    console.error("Cart recovery email failed:", error);
    return false;
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

export interface LowStockLine {
  name: string;
  stock: number;
  lowStockThreshold: number;
}

/**
 * The morning restocking list.
 *
 * Goes to the shop, never to a customer. Sorted by the caller with the emptiest
 * shelf first, so the top of the email is what to deal with today.
 */
export async function sendLowStockDigest(products: LowStockLine[]): Promise<void> {
  if (!isEmailConfigured() || products.length === 0) return;

  const to = shopInbox();
  if (!to) return;

  const soldOut = products.filter((product) => product.stock <= 0).length;

  try {
    const rows = products
      .map(
        (product) => `<tr>
          <td style="padding:8px 0;font-size:14px">${escapeHtml(product.name)}</td>
          <td style="padding:8px 0;font-size:14px;text-align:right;font-weight:600;color:${
            product.stock <= 0 ? "#e05c7e" : "#d98634"
          }">${product.stock === 0 ? "Sold out" : `${product.stock} left`}</td>
        </tr>`
      )
      .join("");

    await sendEmail({
      to,
      subject:
        soldOut > 0
          ? `${soldOut} sold out, ${products.length} need restocking`
          : `${products.length} product(s) need restocking`,
      html: layout(
        "Time to reorder",
        `These are at or below the level you set for them.`,
        `<table style="width:100%;border-collapse:collapse">${rows}</table>
         <p style="margin:24px 0 0"><a href="${storeUrl()}/admin/products"
            style="display:inline-block;padding:12px 24px;border-radius:999px;background:#8b6bff;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">Open the catalogue</a></p>`
      ),
    });
  } catch (error) {
    console.error("Low stock digest email failed:", error);
  }
}