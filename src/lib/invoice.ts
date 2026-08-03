import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Numbering for tax invoices.
 *
 * Rule 46 of the CGST Rules wants a consecutive serial number, at most sixteen
 * characters, unique within a financial year. `SHK/26-27/0001` is fifteen and
 * says which year it belongs to without anyone having to look it up.
 */
const PREFIX = process.env.INVOICE_PREFIX?.trim() || "SHK";

/**
 * The Indian financial year a date falls in, as "26-27".
 *
 * April to March, so anything before April belongs to the year that started the
 * previous April — getting this wrong restarts the series three months early and
 * duplicates every number in it.
 *
 * Read in Asia/Kolkata rather than the server's own clock. This is an Indian
 * tax year and Render runs in UTC, so `getMonth()` would file an order placed at
 * half past midnight IST on 1 April into the year that ended the day before.
 */
const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "numeric",
});

export function financialYear(date: Date): string {
  const parts = IST.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);

  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function formatInvoiceNumber(series: string, sequence: number): string {
  return `${PREFIX}/${series}/${String(sequence).padStart(4, "0")}`;
}

/**
 * Takes the next number in this year's series.
 *
 * Must run inside the same transaction as whatever it is numbering, so an order
 * that fails to save cannot burn a number and leave a gap — a gap is the thing
 * an auditor asks about.
 *
 * The upsert is one statement, so the row is locked for the increment and two
 * payments landing together queue rather than collide.
 */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, when = new Date()): Promise<string> {
  const series = financialYear(when);

  const counter = await tx.invoiceCounter.upsert({
    where: { series },
    create: { series, lastUsed: 1 },
    update: { lastUsed: { increment: 1 } },
    select: { lastUsed: true },
  });

  return formatInvoiceNumber(series, counter.lastUsed);
}

/**
 * Numbers an order if it has not been numbered already.
 *
 * Idempotent on purpose: a Razorpay webhook and the browser's own verification
 * call both land on the paid path, and an invoice that renumbers itself on the
 * second one is a different invoice to the one already in the parcel.
 */
export async function assignInvoiceNumber(
  tx: Prisma.TransactionClient,
  orderId: string,
  when = new Date()
): Promise<string | null> {
  /**
   * The order row is locked before the counter is touched, and that ordering is
   * the whole point.
   *
   * Reading first and claiming afterwards looks safe — the loser's write is
   * conditional and does nothing — but by then it has already incremented the
   * counter, and the number it took is never issued. The series ends up with a
   * hole in it, which is precisely the thing this file exists to avoid. Locking
   * first makes the second caller wait, see the number the first one wrote, and
   * leave the counter alone.
   */
  const locked = await tx.$queryRaw<{ invoiceNumber: string | null }[]>`
    SELECT "invoiceNumber" FROM "Order" WHERE id = ${orderId} FOR UPDATE
  `;

  const order = locked[0];
  if (!order) return null;
  if (order.invoiceNumber) return order.invoiceNumber;

  const invoiceNumber = await nextInvoiceNumber(tx, when);
  await tx.order.update({ where: { id: orderId }, data: { invoiceNumber, invoicedAt: when } });

  return invoiceNumber;
}

/** Whether an order is far enough along to carry an invoice. */
export async function invoiceableOrder(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, invoiceNumber: true, paymentStatus: true, paymentMethod: true },
  });
}
