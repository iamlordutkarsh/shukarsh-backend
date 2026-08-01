import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/**
 * Zeroes the rate on order lines that were never taxed.
 *
 * GST was off for the first part of the deploy — `SELLER_STATE` was unset — and
 * the disabled branch of `computeTax` carried the product's rate through
 * untouched while collecting nothing. Those lines read "5% was applicable and
 * ₹0 was collected", which is indistinguishable from a rounding bug to anyone
 * reconciling them and is the wrong basis if an invoice is ever reissued from
 * stored data. `computeTax` sets `rate: 0` in that branch now; this is for the
 * rows written before it did.
 *
 * Scoped by the order's `taxTotal` rather than the line's own `taxAmount`. A
 * cheap enough line can round its tax to zero with GST fully on, and zeroing
 * that line's rate would be inventing a second wrong answer to fix the first.
 * An order that collected no tax at all across every line is one placed while
 * GST was off.
 *
 * Read-only unless `--apply` is passed, because it is a repair and ought to be
 * looked at before it runs.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  const stale = await prisma.orderItem.findMany({
    where: {
      gstRate: { gt: 0 },
      taxAmount: 0,
      order: { taxTotal: 0 },
    },
    select: {
      id: true,
      gstRate: true,
      product: { select: { name: true } },
      order: { select: { id: true, createdAt: true } },
    },
    orderBy: { order: { createdAt: "asc" } },
  });

  if (stale.length === 0) {
    console.log("No order line records a rate it never collected.");
    return;
  }

  for (const item of stale) {
    // Same short reference the customer's emails print, so a line found here can
    // be matched to the order it belongs to without a lookup.
    const reference = item.order.id.slice(0, 8).toUpperCase();
    console.log(
      `${apply ? "FIXING" : "STALE "}  ${reference}  ${item.product.name}: ` +
        `records ${item.gstRate}% against ₹0 collected`
    );
  }

  if (!apply) {
    console.log(`\n${stale.length} line(s) on untaxed orders. Re-run with --apply to zero them.`);
    return;
  }

  const { count } = await prisma.orderItem.updateMany({
    where: { id: { in: stale.map((item) => item.id) } },
    data: { gstRate: 0 },
  });

  console.log(`\nZeroed the rate on ${count} line(s). The amounts they were charged are untouched.`);
}

main()
  .catch((error) => {
    console.error("Could not check the rates:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
