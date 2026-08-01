import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { AttributeError, saveProductAttributes } from "../src/lib/attributes";
import { descendantIds, effectiveAttributes } from "../src/lib/category";
import { facetsFor } from "../src/lib/facets";
import { priceCart } from "../src/lib/shipping";

/**
 * Drives the category tree, its questions, colours, sizes and facets end to end.
 *
 * These features shipped without ever running against a database: everything was
 * type-checked, and a type check cannot tell you that inheritance collects the
 * wrong ancestor or that a facet count is off by one. This builds a small shop,
 * asks it the questions the real screens ask, and tears it down again.
 *
 * It **writes**, unlike the other diagnostics. Everything it makes is prefixed
 * and deleted at both ends of the run, so a crashed attempt cleans itself up on
 * the next one. It is still not something to point at a busy production database
 * for fun — run it once to prove the wiring, then leave it alone.
 */

/** Distinctive enough that nothing real could collide with it. */
const PREFIX = "zz-catalogue-check";

let failures = 0;

function check(claim: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`  ok    ${claim}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${claim}${detail ? ` — ${detail}` : ""}`);
}

/** Removes anything a previous run left behind. Products first: they point at categories. */
async function cleanup() {
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.colourPreset.deleteMany({ where: { name: { startsWith: PREFIX } } });

  // Children before parents, since a category still holding one cannot go.
  for (let pass = 0; pass < 4; pass += 1) {
    await prisma.category.deleteMany({
      where: { slug: { startsWith: PREFIX }, children: { none: {} } },
    });
  }
}

async function main() {
  await cleanup();

  console.log("Building a small shop...");

  const root = await prisma.category.create({
    data: { name: "ZZ Fashion", slug: `${PREFIX}-fashion` },
  });
  const mid = await prisma.category.create({
    data: { name: "ZZ Clothing", slug: `${PREFIX}-clothing`, parentId: root.id },
  });
  const leaf = await prisma.category.create({
    data: { name: "ZZ Tshirts", slug: `${PREFIX}-tshirts`, parentId: mid.id },
  });

  // Asked at the top, so everything below inherits it.
  await prisma.attributeDefinition.create({
    data: {
      categoryId: root.id,
      key: "origin",
      label: "Country of origin",
      kind: "SELECT",
      required: true,
      filterable: true,
      position: 0,
      options: { create: [{ value: "India", position: 0 }, { value: "Bangladesh", position: 1 }] },
    },
  });

  // Asked only at the leaf.
  await prisma.attributeDefinition.create({
    data: {
      categoryId: leaf.id,
      key: "fabric",
      label: "Fabric",
      kind: "SELECT",
      required: true,
      filterable: true,
      position: 1,
      options: { create: [{ value: "Cotton", position: 0 }, { value: "Blend", position: 1 }] },
    },
  });

  console.log("\nInheritance");

  const atLeaf = await effectiveAttributes(leaf.id);
  check("a leaf inherits its ancestor's question", atLeaf.some((a) => a.key === "origin"));
  check("a leaf keeps its own question", atLeaf.some((a) => a.key === "fabric"));
  check(
    "an inherited question is marked as inherited",
    atLeaf.find((a) => a.key === "origin")?.inherited === true
  );
  check(
    "an own question is not marked as inherited",
    atLeaf.find((a) => a.key === "fabric")?.inherited === false
  );
  check("the general question comes first", atLeaf[0]?.key === "origin");

  const atRoot = await effectiveAttributes(root.id);
  check("a question does not leak upwards", !atRoot.some((a) => a.key === "fabric"));

  console.log("\nThe tree");

  const under = await descendantIds(root.id);
  check("descendants reach the leaf", under.includes(leaf.id), `got ${under.length} categories`);
  check("descendants include the category itself", under.includes(root.id));
  check("a leaf has only itself below it", (await descendantIds(leaf.id)).length === 1);

  console.log("\nA product with colours and sizes");

  const product = await prisma.product.create({
    data: {
      name: "ZZ Test Tee",
      slug: `${PREFIX}-tee`,
      price: 500,
      categoryId: leaf.id,
      isActive: true,
    },
  });

  const navy = await prisma.productColour.create({
    data: { productId: product.id, name: "Navy", hex: "#101a3d", position: 0 },
  });
  const rust = await prisma.productColour.create({
    data: { productId: product.id, name: "Rust", hex: "#a4472a", hex2: "#e0c8a0", position: 1 },
  });

  // Navy in two sizes, Rust in one, and the large one costs more.
  const navyM = await prisma.productVariant.create({
    data: { productId: product.id, colourId: navy.id, label: "M", stock: 5, position: 0 },
  });
  await prisma.productVariant.create({
    data: { productId: product.id, colourId: navy.id, label: "L", stock: 2, price: 650, position: 1 },
  });
  await prisma.productVariant.create({
    data: { productId: product.id, colourId: rust.id, label: "M", stock: 0, position: 2 },
  });

  await prisma.product.update({ where: { id: product.id }, data: { stock: 7 } });

  console.log("\nAnswers");

  try {
    await prisma.$transaction((tx) => saveProductAttributes(tx, product.id, leaf.id, []));
    check("a required question cannot be skipped", false, "the save was allowed");
  } catch (error) {
    check("a required question cannot be skipped", error instanceof AttributeError);
  }

  try {
    await prisma.$transaction((tx) =>
      saveProductAttributes(tx, product.id, leaf.id, [
        { key: "origin", values: ["India"] },
        { key: "fabric", values: ["Linen"] },
      ])
    );
    check("a value off the list is refused", false, "the save was allowed");
  } catch (error) {
    check("a value off the list is refused", error instanceof AttributeError);
  }

  await prisma.$transaction((tx) =>
    saveProductAttributes(tx, product.id, leaf.id, [
      { key: "origin", values: ["India"] },
      { key: "fabric", values: ["Cotton"] },
    ])
  );

  const saved = await prisma.productAttribute.count({ where: { productId: product.id } });
  check("both answers were written", saved === 2, `found ${saved}`);

  console.log("\nPricing");

  const cart = await priceCart([{ productId: product.id, variantId: navyM.id, quantity: 1 }]);
  check("a cell prices at the product price when it has none", cart.lines[0]?.price === 500);
  check("the colour is snapshotted onto the line", cart.lines[0]?.variantColour === "Navy");
  check("the size is snapshotted onto the line", cart.lines[0]?.variantLabel === "M");

  const large = await prisma.productVariant.findFirst({
    where: { productId: product.id, label: "L" },
  });
  const dearer = await priceCart([
    { productId: product.id, variantId: large!.id, quantity: 1 },
  ]);
  check("a cell with its own price overrides the product", dearer.lines[0]?.price === 650);

  try {
    await priceCart([{ productId: product.id, quantity: 1 }]);
    check("a bag naming no option is refused", false, "the bag was priced");
  } catch {
    check("a bag naming no option is refused", true);
  }

  console.log("\nFacets");

  const base = { isActive: true, categoryId: { in: await descendantIds(root.id) } };

  const facets = await facetsFor({ base, selected: {} });
  const fabric = facets.find((facet) => facet.key === "fabric");
  check("a filterable question is offered", Boolean(fabric));
  check("the answered option is counted", fabric?.values.find((v) => v.value === "Cotton")?.count === 1);
  check(
    "an option nothing answered is hidden",
    !fabric?.values.some((v) => v.value === "Blend"),
    "Blend should not appear"
  );

  const narrowed = await facetsFor({ base, selected: { fabric: ["Cotton"] } });
  const stillThere = narrowed.find((facet) => facet.key === "fabric");
  check(
    "a picked option stays visible once picked",
    stillThere?.values.find((v) => v.value === "Cotton")?.selected === true
  );
  check(
    "the other question survives a narrowing",
    narrowed.some((facet) => facet.key === "origin")
  );

  const matching = await prisma.product.count({
    where: {
      AND: [
        base,
        { attributes: { some: { definition: { key: "fabric" }, option: { value: "Cotton" } } } },
      ],
    },
  });
  check("filtering finds the product", matching === 1, `found ${matching}`);

  const missing = await prisma.product.count({
    where: {
      AND: [
        base,
        { attributes: { some: { definition: { key: "fabric" }, option: { value: "Blend" } } } },
      ],
    },
  });
  check("filtering excludes what does not match", missing === 0, `found ${missing}`);

  console.log("\nTwo-tone");
  check("a second hex round-trips", rust.hex2 === "#e0c8a0");
}

main()
  .then(async () => {
    await cleanup();
    console.log(
      failures === 0
        ? "\nEverything checked out. The shop it built has been removed."
        : `\n${failures} check(s) failed. The shop it built has been removed.`
    );
    if (failures > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    console.error("\nThe check itself broke:", error);
    // Still tidied up, so a failure does not leave a half-built shop behind.
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
