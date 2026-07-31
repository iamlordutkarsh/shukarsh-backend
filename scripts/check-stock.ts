import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { balanceFrom } from "../src/lib/inventory";

/**
 * Compares every shelf against the sum of its ledger.
 *
 * The two can only disagree if something wrote to a stock column without
 * recording why, which is the bug this whole table exists to catch. Needs a
 * database, so it is a diagnostic to run by hand rather than part of the build.
 *
 * Three claims are checked, because sizes give the count two more ways to lie:
 * each product against its own movements, each size against the movements filed
 * against it, and a product's total against the sum of its sizes.
 */
async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      stock: true,
      stockMoves: { select: { delta: true, variantId: true } },
      variants: { select: { id: true, label: true, stock: true }, orderBy: { position: "asc" } },
    },
    orderBy: { name: "asc" },
  });

  let drifted = 0;
  let checked = 0;

  for (const product of products) {
    checked += 1;
    const expected = balanceFrom(product.stockMoves);

    if (expected !== product.stock) {
      drifted += 1;
      console.log(
        `DRIFT  ${product.name}: shelf says ${product.stock}, ledger says ${expected} ` +
          `(${product.stockMoves.length} movement(s))`
      );
    }

    for (const variant of product.variants) {
      checked += 1;
      const moves = product.stockMoves.filter((move) => move.variantId === variant.id);
      const expectedSize = balanceFrom(moves);

      if (expectedSize !== variant.stock) {
        drifted += 1;
        console.log(
          `DRIFT  ${product.name} · ${variant.label}: shelf says ${variant.stock}, ` +
            `ledger says ${expectedSize} (${moves.length} movement(s))`
        );
      }
    }

    if (product.variants.length > 0) {
      checked += 1;
      const sum = product.variants.reduce((total, variant) => total + variant.stock, 0);

      if (sum !== product.stock) {
        drifted += 1;
        console.log(
          `DRIFT  ${product.name}: total says ${product.stock}, its ${product.variants.length} ` +
            `size(s) add up to ${sum}`
        );
      }
    }
  }

  console.log(
    drifted === 0
      ? `\nAll ${checked} count(s) across ${products.length} product(s) agree with their ledger.`
      : `\n${drifted} of ${checked} count(s) disagree with their ledger.`
  );

  await prisma.$disconnect();
  process.exit(drifted === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
