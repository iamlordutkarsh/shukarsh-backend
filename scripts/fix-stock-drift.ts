import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { moveStock } from "../src/lib/inventory";

/**
 * Puts every product's total back to the sum of its shelves.
 *
 * Once a product has colours or sizes, its own `stock` is only their sum. A few
 * ways of writing it directly slipped through — the product form did until it
 * was stopped, and an adjustment that failed to name a shelf landed on the
 * product instead — leaving totals that no shelf backs. The symptom is a product
 * page reading "in stock" beside a sold out button.
 *
 * The difference is written through the ledger rather than assigned, so the
 * correction is explained rather than appearing overnight. Products with no
 * options are left alone: their total is the truth, not a derived figure.
 *
 * Read-only unless `--apply` is passed, because it is a repair and ought to be
 * looked at before it runs.
 */
async function main() {
  const apply = process.argv.includes("--apply");

  const products = await prisma.product.findMany({
    where: { variants: { some: {} } },
    select: {
      id: true,
      name: true,
      stock: true,
      variants: { select: { stock: true, isActive: true } },
    },
    orderBy: { name: "asc" },
  });

  let drifted = 0;

  for (const product of products) {
    // Withdrawn shelves still hold units, and the total has always counted them:
    // this is about what exists, not what is for sale.
    const shelves = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
    if (shelves === product.stock) continue;

    drifted += 1;
    console.log(
      `${apply ? "FIXING" : "DRIFT "}  ${product.name}: total says ${product.stock}, ` +
        `its ${product.variants.length} option(s) hold ${shelves}`
    );

    if (!apply) continue;

    await prisma.$transaction((tx) =>
      moveStock(tx, {
        productId: product.id,
        delta: shelves - product.stock,
        reason: "CORRECTION",
        note: "Total put back to the sum of its options",
        allowNegative: true,
      })
    );
  }

  if (drifted === 0) {
    console.log(`Checked ${products.length} product(s) with options. Every total matches.`);
    return;
  }

  console.log(
    apply
      ? `\nPut ${drifted} total(s) right. Each change is on the ledger.`
      : `\n${drifted} product(s) drifted. Re-run with --apply to correct them.`
  );
}

main()
  .catch((error) => {
    console.error("Could not check the totals:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
