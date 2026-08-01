import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTree } from "../src/lib/category";
import { facetWhere, readFacets } from "../src/lib/facets";
import { priceSpread, readDetails, readSpecs, variantPrice } from "../src/lib/product";
import { serializeProductAttributes } from "../src/lib/attributes";
import { collapseLines, variantName } from "../src/lib/shipping";

/**
 * The parts of the catalogue that need no database.
 *
 * Everything here is a pure function, which is why it can be tested at all: the
 * rest of the feature talks to Postgres and is covered by `npm run
 * check:catalogue` instead. What lives here is the arithmetic and the parsing —
 * the code where an off-by-one or a dropped null is invisible until a shopper
 * finds it.
 */

const category = (id: string, parentId: string | null, position = 0, name = id) => ({
  id,
  name,
  slug: id,
  description: null,
  image: null,
  position,
  parentId,
});

describe("buildTree", () => {
  it("nests children under their parent", () => {
    const tree = buildTree([
      category("root", null),
      category("mid", "root"),
      category("leaf", "mid"),
    ]);

    assert.equal(tree.length, 1);
    assert.equal(tree[0].children?.[0].id, "mid");
    assert.equal(tree[0].children?.[0].children?.[0].id, "leaf");
  });

  it("orders siblings by position, then by name", () => {
    const tree = buildTree([
      category("b", null, 1),
      category("a", null, 2),
      category("c", null, 0),
    ]);

    assert.deepEqual(tree.map((node) => node.id), ["c", "b", "a"]);
  });

  it("treats a child whose parent is missing as a root", () => {
    // An orphan an admin can see is fixable; one that silently vanishes is not.
    const tree = buildTree([category("kept", null), category("orphan", "gone")]);

    assert.deepEqual(tree.map((node) => node.id).sort(), ["kept", "orphan"]);
  });

  it("does not hang on a category that is its own parent", () => {
    const tree = buildTree([category("loop", "loop")]);
    assert.equal(tree.length, 0, "a self-parented row nests into itself and has no root");
  });
});

describe("readFacets", () => {
  it("splits several values for one question", () => {
    assert.deepEqual(readFacets({ fabric: "Cotton,Blend" }), { fabric: ["Cotton", "Blend"] });
  });

  it("trims and drops the empties", () => {
    assert.deepEqual(readFacets({ fabric: " Cotton , , Blend " }), { fabric: ["Cotton", "Blend"] });
  });

  it("drops a key that could not be a question", () => {
    // A hand-edited link should widen the result, not 400.
    assert.deepEqual(readFacets({ "Fabric!": "Cotton" }), {});
  });

  it("drops a question with nothing left in it", () => {
    assert.deepEqual(readFacets({ fabric: " , " }), {});
  });

  it("ignores anything that is not a query string", () => {
    assert.deepEqual(readFacets(undefined), {});
    assert.deepEqual(readFacets("fabric=Cotton"), {});
    assert.deepEqual(readFacets(["fabric"]), {});
    assert.deepEqual(readFacets({ fabric: ["Cotton"] }), {});
  });
});

describe("facetWhere", () => {
  it("makes one condition per question", () => {
    const where = facetWhere({ fabric: ["Cotton"], sleeve: ["Half"] });
    assert.equal(where.length, 2);
  });

  it("ors the values within one question", () => {
    // Anding them would ask for a shirt that is both cotton and blend, which is
    // nothing at all.
    const [where] = facetWhere({ fabric: ["Cotton", "Blend"] });
    const option = (where.attributes as any).some.option;
    assert.deepEqual(option.value.in, ["Cotton", "Blend"]);
  });

  it("leaves out the question it was told to skip", () => {
    // This is what keeps the other fabrics visible after one is ticked.
    const where = facetWhere({ fabric: ["Cotton"], sleeve: ["Half"] }, "fabric");
    assert.equal(where.length, 1);
    assert.equal((where[0].attributes as any).some.definition.key, "sleeve");
  });
});

describe("priceSpread", () => {
  it("reports the product price when nothing overrides it", () => {
    assert.deepEqual(priceSpread(500, [{ isActive: true }, { isActive: true }]), {
      priceFrom: 500,
      priceTo: 500,
    });
  });

  it("widens to the cheapest and dearest cell", () => {
    assert.deepEqual(priceSpread(500, [{ isActive: true }, { price: 650, isActive: true }]), {
      priceFrom: 500,
      priceTo: 650,
    });
  });

  it("ignores a withdrawn cell", () => {
    // A retired XXL at double the price would otherwise quote a price nobody can
    // reach.
    assert.deepEqual(priceSpread(500, [{ isActive: true }, { price: 900, isActive: false }]), {
      priceFrom: 500,
      priceTo: 500,
    });
  });

  it("falls back to the product when every cell is withdrawn", () => {
    assert.deepEqual(priceSpread(500, [{ price: 900, isActive: false }]), {
      priceFrom: 500,
      priceTo: 500,
    });
  });
});

describe("totalStock (the badge and the buy button must agree)", () => {
  // A product page once showed "in stock" beside a sold out button, because the
  // badge read the product total and the button read the cells. Whichever the
  // button obeys is the one worth printing.
  const totalStock = (product: { stock: number; variants: { stock: number; isActive: boolean }[] }) => {
    const cells = product.variants.filter((variant) => variant.isActive);
    if (cells.length === 0) return product.stock;
    return cells.reduce((sum, cell) => sum + cell.stock, 0);
  };

  it("uses the product's own total when it has no options", () => {
    assert.equal(totalStock({ stock: 22, variants: [] }), 22);
  });

  it("ignores a product total that disagrees with its cells", () => {
    assert.equal(
      totalStock({ stock: 22, variants: [{ stock: 0, isActive: true }, { stock: 0, isActive: true }] }),
      0
    );
  });

  it("adds the cells up", () => {
    assert.equal(
      totalStock({ stock: 0, variants: [{ stock: 5, isActive: true }, { stock: 2, isActive: true }] }),
      7
    );
  });

  it("leaves a withdrawn cell out of the count", () => {
    assert.equal(
      totalStock({ stock: 99, variants: [{ stock: 5, isActive: true }, { stock: 9, isActive: false }] }),
      5
    );
  });
});

describe("variantPrice", () => {
  it("uses the cell's own price when it has one", () => {
    assert.equal(variantPrice({ price: 650 }, 500), 650);
  });

  it("falls back to the product otherwise", () => {
    assert.equal(variantPrice({}, 500), 500);
    assert.equal(variantPrice({ price: null }, 500), 500);
  });

  it("does not mistake a free cell for an absent price", () => {
    assert.equal(variantPrice({ price: 0 }, 500), 0);
  });
});

describe("readSpecs", () => {
  it("keeps a well formed row", () => {
    assert.deepEqual(readSpecs([{ label: "Material", value: "Steel" }]), [
      { label: "Material", value: "Steel" },
    ]);
  });

  it("drops a half finished row rather than failing the page", () => {
    assert.deepEqual(readSpecs([{ label: "Material", value: "" }, { label: "", value: "Steel" }]), []);
  });

  it("survives a column that is not a list", () => {
    assert.deepEqual(readSpecs(null), []);
    assert.deepEqual(readSpecs({ label: "Material" }), []);
    assert.deepEqual(readSpecs([null, 7, "nope"]), []);
  });
});

describe("readDetails", () => {
  it("keeps each of the three shapes", () => {
    const blocks = readDetails([
      { kind: "text", title: "About", body: "Words." },
      { kind: "highlights", title: "Why", items: ["One", "Two"] },
      { kind: "faq", title: "Asked", items: [{ question: "Q", answer: "A" }] },
    ]);

    assert.deepEqual(blocks.map((block) => block.kind), ["text", "highlights", "faq"]);
  });

  it("drops a block with a shape it does not know", () => {
    assert.deepEqual(readDetails([{ kind: "video", title: "Watch", url: "x" }]), []);
  });

  it("drops a block that lost its content", () => {
    assert.deepEqual(readDetails([{ kind: "text", title: "About", body: "  " }]), []);
    assert.deepEqual(readDetails([{ kind: "highlights", title: "Why", items: [] }]), []);
    assert.deepEqual(readDetails([{ kind: "faq", title: "Asked", items: [{ question: "Q" }] }]), []);
  });

  it("keeps the good rows of a partly broken block", () => {
    const [block] = readDetails([
      { kind: "highlights", title: "Why", items: ["One", "", 7, "Two"] },
    ]);

    assert.deepEqual((block as { items: string[] }).items, ["One", "Two"]);
  });
});

describe("serializeProductAttributes", () => {
  const definition = (key: string, label: string, position = 0) => ({
    key,
    label,
    kind: "SELECT",
    unit: null,
    position,
  });

  it("groups several answers to one question into one row", () => {
    const rows = serializeProductAttributes([
      { definition: definition("occasion", "Occasion"), option: { value: "Festive" } },
      { definition: definition("occasion", "Occasion"), option: { value: "Gifting" } },
    ]);

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].values, ["Festive", "Gifting"]);
  });

  it("reads each kind out of its own column", () => {
    const rows = serializeProductAttributes([
      { definition: definition("fabric", "Fabric", 0), option: { value: "Cotton" } },
      { definition: definition("note", "Note", 1), valueText: "Handmade" },
      { definition: definition("gsm", "Weight", 2), valueNumber: "180" },
    ]);

    assert.deepEqual(rows.map((row) => row.values[0]), ["Cotton", "Handmade", "180"]);
  });

  it("orders by the position its category asks in", () => {
    const rows = serializeProductAttributes([
      { definition: definition("b", "Second", 5), option: { value: "x" } },
      { definition: definition("a", "First", 1), option: { value: "y" } },
    ]);

    assert.deepEqual(rows.map((row) => row.label), ["First", "Second"]);
  });

  it("drops a row whose answer went missing", () => {
    assert.deepEqual(serializeProductAttributes([{ definition: definition("fabric", "Fabric") }]), []);
  });
});

describe("variantName", () => {
  it("joins a colour and a size", () => {
    assert.equal(variantName({ label: "M", colour: { name: "Navy" } }), "Navy · M");
  });

  it("writes no separator when there is only one thing to name", () => {
    assert.equal(variantName({ label: "M", colour: null }), "M");
    assert.equal(variantName({ label: "", colour: { name: "Navy" } }), "Navy");
  });

  it("is null when there is nothing to name", () => {
    assert.equal(variantName(null), null);
    assert.equal(variantName({ label: "", colour: null }), null);
  });
});

describe("collapseLines", () => {
  it("adds up the same thing sent twice", () => {
    // /orders/create is public, so the same line really can arrive twice, and
    // checking them separately oversells.
    const lines = collapseLines([
      { productId: "p", variantId: "v", quantity: 5 },
      { productId: "p", variantId: "v", quantity: 5 },
    ]);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 10);
  });

  it("keeps two sizes of one product apart", () => {
    const lines = collapseLines([
      { productId: "p", variantId: "m", quantity: 1 },
      { productId: "p", variantId: "l", quantity: 1 },
    ]);

    assert.equal(lines.length, 2, "they come off two different shelves");
  });

  it("treats a missing variant as its own line", () => {
    const lines = collapseLines([
      { productId: "p", quantity: 1 },
      { productId: "p", variantId: "m", quantity: 1 },
    ]);

    assert.equal(lines.length, 2);
    assert.equal(lines[0].variantId, null);
  });
});
