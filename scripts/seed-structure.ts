import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/**
 * Fills in the shape of the shop: subcategories, the questions each one asks,
 * and a starting colour palette.
 *
 * The catalogue has the three departments the original seed made and nothing
 * under them, which means the category picker shows one column and every product
 * form says the category asks for nothing. None of that is broken — there is
 * simply nothing there yet, and clicking it in by hand is half an hour before
 * anything can be tried.
 *
 * Everything here is upserted by its natural key, so running it twice changes
 * nothing and running it against a shop that has already been edited leaves those
 * edits alone. It **adds only**: no category, question or option is ever removed,
 * because this script cannot tell the difference between something it created and
 * something the shop deliberately changed.
 */

/** A question, with the answers it will accept. */
interface Question {
  key: string;
  label: string;
  kind: "SELECT" | "MULTISELECT" | "TEXT" | "NUMBER";
  required?: boolean;
  filterable?: boolean;
  unit?: string;
  options?: string[];
}

interface Branch {
  name: string;
  slug: string;
  questions?: Question[];
  children?: Branch[];
}

/**
 * Asked of everything, on every department.
 *
 * Country of origin is on the label of anything packaged and sold online in
 * India, so it is asked rather than hoped for. It sits on each department rather
 * than one shared root because the shop has three roots, not one.
 */
const UNIVERSAL: Question[] = [
  {
    key: "origin",
    label: "Country of origin",
    kind: "SELECT",
    required: true,
    options: ["India", "China", "Bangladesh", "Vietnam", "Other"],
  },
];

const TREE: Branch[] = [
  {
    name: "Kitchen",
    slug: "kitchen",
    questions: [
      ...UNIVERSAL,
      {
        key: "material",
        label: "Material",
        kind: "SELECT",
        required: true,
        filterable: true,
        options: ["Stainless steel", "Ceramic", "Glass", "Silicone", "Wood", "Bamboo", "Plastic", "Cast iron"],
      },
      { key: "dishwasher-safe", label: "Dishwasher safe", kind: "SELECT", filterable: true, options: ["Yes", "No"] },
    ],
    children: [
      {
        name: "Cookware",
        slug: "kitchen-cookware",
        questions: [
          { key: "capacity", label: "Capacity", kind: "NUMBER", unit: "litres" },
          { key: "induction", label: "Induction friendly", kind: "SELECT", filterable: true, options: ["Yes", "No"] },
        ],
      },
      {
        name: "Storage",
        slug: "kitchen-storage",
        questions: [
          { key: "capacity", label: "Capacity", kind: "NUMBER", unit: "ml" },
          { key: "airtight", label: "Airtight", kind: "SELECT", filterable: true, options: ["Yes", "No"] },
        ],
      },
      {
        name: "Serveware",
        slug: "kitchen-serveware",
        questions: [
          { key: "pieces", label: "Pieces in the set", kind: "NUMBER" },
          {
            key: "occasion",
            label: "Occasion",
            kind: "MULTISELECT",
            filterable: true,
            options: ["Everyday", "Festive", "Gifting"],
          },
        ],
      },
    ],
  },
  {
    name: "Clothing",
    slug: "clothing",
    questions: [
      ...UNIVERSAL,
      {
        key: "fabric",
        label: "Fabric",
        kind: "SELECT",
        required: true,
        filterable: true,
        options: ["Cotton", "Linen", "Rayon", "Georgette", "Chiffon", "Silk", "Polyester", "Blend"],
      },
      {
        key: "wash-care",
        label: "Wash care",
        kind: "SELECT",
        filterable: true,
        options: ["Machine wash", "Hand wash", "Dry clean only"],
      },
    ],
    children: [
      {
        name: "Women",
        slug: "clothing-women",
        children: [
          {
            name: "Kurtis",
            slug: "clothing-women-kurtis",
            questions: [
              { key: "fit", label: "Fit", kind: "SELECT", filterable: true, options: ["Regular", "Relaxed", "A-line", "Straight"] },
              { key: "sleeve", label: "Sleeve length", kind: "SELECT", filterable: true, options: ["Sleeveless", "Short sleeve", "Three quarter", "Full sleeve"] },
              { key: "length", label: "Length", kind: "SELECT", filterable: true, options: ["Short", "Knee length", "Calf length", "Ankle length"] },
            ],
          },
          {
            name: "Tops",
            slug: "clothing-women-tops",
            questions: [
              { key: "fit", label: "Fit", kind: "SELECT", filterable: true, options: ["Regular", "Relaxed", "Fitted", "Oversized"] },
              { key: "sleeve", label: "Sleeve length", kind: "SELECT", filterable: true, options: ["Sleeveless", "Short sleeve", "Three quarter", "Full sleeve"] },
              { key: "neck", label: "Neck", kind: "SELECT", filterable: true, options: ["Round", "V neck", "Collared", "Square", "Boat"] },
            ],
          },
        ],
      },
      {
        name: "Men",
        slug: "clothing-men",
        children: [
          {
            name: "Tshirts",
            slug: "clothing-men-tshirts",
            questions: [
              { key: "fit", label: "Fit", kind: "SELECT", filterable: true, options: ["Regular", "Slim", "Oversized"] },
              { key: "sleeve", label: "Sleeve length", kind: "SELECT", filterable: true, options: ["Half sleeve", "Full sleeve"] },
              { key: "neck", label: "Neck", kind: "SELECT", filterable: true, options: ["Round", "V neck", "Polo", "Henley"] },
            ],
          },
          {
            name: "Shirts",
            slug: "clothing-men-shirts",
            questions: [
              { key: "fit", label: "Fit", kind: "SELECT", filterable: true, options: ["Regular", "Slim"] },
              { key: "pattern", label: "Pattern", kind: "SELECT", filterable: true, options: ["Solid", "Striped", "Checked", "Printed"] },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Artificial Nails",
    slug: "artificial-nails",
    questions: [
      ...UNIVERSAL,
      { key: "shape", label: "Shape", kind: "SELECT", required: true, filterable: true, options: ["Almond", "Coffin", "Square", "Squoval", "Stiletto", "Round"] },
      { key: "nail-length", label: "Length", kind: "SELECT", required: true, filterable: true, options: ["Short", "Medium", "Long", "Extra long"] },
      { key: "finish", label: "Finish", kind: "SELECT", filterable: true, options: ["Glossy", "Matte", "Glitter", "Chrome"] },
      { key: "pieces", label: "Nails in the set", kind: "NUMBER" },
      { key: "reusable", label: "Reusable", kind: "SELECT", filterable: true, options: ["Yes", "No"] },
    ],
  },
];

/** A starting palette. Names a shop would actually write on a swatch. */
const PALETTE: { name: string; hex: string; hex2?: string }[] = [
  { name: "Black", hex: "#1c1c1e" },
  { name: "White", hex: "#f8f7f4" },
  { name: "Ivory", hex: "#f2e8d5" },
  { name: "Beige", hex: "#d9c7ad" },
  { name: "Navy", hex: "#1b2a4a" },
  { name: "Sky blue", hex: "#8fc1e3" },
  { name: "Sage", hex: "#a3b899" },
  { name: "Bottle green", hex: "#1e4d3b" },
  { name: "Mustard", hex: "#d9a441" },
  { name: "Rust", hex: "#a4472a" },
  { name: "Maroon", hex: "#6a1f2b" },
  { name: "Blush pink", hex: "#f0c2ce" },
  { name: "Lavender", hex: "#b9a7dd" },
  { name: "Grey", hex: "#8d8d92" },
  // Two-tone, for the prints and stripes a single hex cannot describe.
  { name: "Black & white print", hex: "#1c1c1e", hex2: "#f8f7f4" },
  { name: "Multicolour", hex: "#e0685f", hex2: "#5f8fe0" },
];

let categoriesAdded = 0;
let questionsAdded = 0;

async function saveQuestions(categoryId: string, questions: Question[], position = 0) {
  for (const [index, question] of questions.entries()) {
    const before = await prisma.attributeDefinition.findUnique({
      where: { categoryId_key: { categoryId, key: question.key } },
    });
    if (!before) questionsAdded += 1;

    const definition = await prisma.attributeDefinition.upsert({
      where: { categoryId_key: { categoryId, key: question.key } },
      create: {
        categoryId,
        key: question.key,
        label: question.label,
        kind: question.kind,
        unit: question.unit ?? null,
        required: question.required ?? false,
        // Only ever true for the picked kinds: nobody filters a shop by free text.
        filterable: (question.filterable ?? false) && question.kind !== "TEXT" && question.kind !== "NUMBER",
        position: position + index,
      },
      // Left alone once it exists. A shop that renamed "Fabric" to "Material"
      // or made it optional meant it, and a rerun must not undo that.
      update: {},
    });

    for (const [order, value] of (question.options ?? []).entries()) {
      await prisma.attributeOption.upsert({
        where: { definitionId_value: { definitionId: definition.id, value } },
        create: { definitionId: definition.id, value, position: order },
        update: {},
      });
    }
  }
}

async function saveBranch(branch: Branch, parentId: string | null, position: number) {
  const existing = await prisma.category.findUnique({ where: { slug: branch.slug } });
  if (!existing) categoriesAdded += 1;

  const category = await prisma.category.upsert({
    where: { slug: branch.slug },
    create: { name: branch.name, slug: branch.slug, parentId, position },
    // Only the placement is corrected on a rerun. The name and description are
    // the shop's to change.
    update: { parentId, position },
  });

  await saveQuestions(category.id, branch.questions ?? []);

  for (const [index, child] of (branch.children ?? []).entries()) {
    await saveBranch(child, category.id, index);
  }
}

async function main() {
  console.log("Filling in the shape of the shop...\n");

  for (const [index, branch] of TREE.entries()) {
    await saveBranch(branch, null, index);
  }

  let coloursAdded = 0;
  for (const [index, colour] of PALETTE.entries()) {
    const before = await prisma.colourPreset.findUnique({ where: { name: colour.name } });
    if (!before) coloursAdded += 1;

    await prisma.colourPreset.upsert({
      where: { name: colour.name },
      create: { name: colour.name, hex: colour.hex, hex2: colour.hex2 ?? null, position: index },
      update: {},
    });
  }

  const total = await prisma.category.count();
  const questions = await prisma.attributeDefinition.count();
  const colours = await prisma.colourPreset.count();

  console.log(`Categories:  ${total} in the tree (${categoriesAdded} new)`);
  console.log(`Questions:   ${questions} across them (${questionsAdded} new)`);
  console.log(`Colours:     ${colours} in the palette (${coloursAdded} new)`);
  console.log("\nNothing was removed. Run it again as often as you like.");
}

main()
  .catch((error) => {
    console.error("Could not seed the structure:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
