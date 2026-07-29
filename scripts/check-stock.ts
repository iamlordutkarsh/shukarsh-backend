import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { balanceFrom } from "../src/lib/inventory";

/**
 * Compares every product's stock against the sum of its ledger.
 *
 * The two can only disagree if something wrote to Product.stock without recording
 * why, which is the bug this whole table exists to catch. Needs a database, so it
 * is a diagnostic to run by hand rather than part of the build.
 */
async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      stock: true,
      stockMoves: { select: { delta: true } },
    },
    orderBy: { name: "asc" },
  });

  let drifted = 0;

  for (const product of products) {
    const expected = balanceFrom(product.stockMoves);
    if (expected === product.stock) continue;

    drifted += 1;
    console.log(
      `DRIFT  ${product.name}: shelf says ${product.stock}, ledger says ${expected} ` +
        `(${product.stockMoves.length} movement(s))`
    );
  }

  console.log(
    drifted === 0
      ? `\nAll ${products.length} product(s) agree with their ledger.`
      : `\n${drifted} of ${products.length} product(s) disagree with their ledger.`
  );

  await prisma.$disconnect();
  process.exit(drifted === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
