import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { serializeProducts } from "../lib/product";
import {
  ancestorsOf,
  buildTree,
  descendantIds,
  effectiveAttributes,
  serializeCategory,
} from "../lib/category";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  image: z.string().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  /** Null puts it back at the top level; absent leaves the parent alone. */
  parentId: z.string().nullable().optional(),
});

const attributeSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    // Ends up in a filter query string, so it has to survive being a URL.
    .regex(/^[a-z0-9-]+$/, "A key is lower case letters, numbers and dashes"),
  label: z.string().trim().min(1).max(60),
  kind: z.enum(["SELECT", "MULTISELECT", "TEXT", "NUMBER"]).default("SELECT"),
  unit: z.string().trim().max(16).optional().nullable(),
  required: z.boolean().default(false),
  filterable: z.boolean().default(false),
  /** The whole list, in order. Ignored for TEXT and NUMBER. */
  options: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
});

/**
 * The whole tree, and the flat list beside it.
 *
 * Both, because callers want different shapes and neither is free to derive: the
 * admin's column picker walks `tree`, while a select box naming a parent wants
 * `categories`. One read answers both.
 */
router.get("/", async (_req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  res.json({ categories: categories.map(serializeCategory), tree: buildTree(categories) });
});

/** Every question a product filed here has to answer, ancestors included. */
router.get("/:id/attributes", async (req, res) => {
  const category = await prisma.category.findUnique({
    where: { id: req.params.id as string },
    select: { id: true },
  });

  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  res.json({ attributes: await effectiveAttributes(category.id) });
});

/**
 * Sets one question on one category.
 *
 * Keyed on `key` rather than an id, so the admin screen saves the same way
 * whether it is creating the question or editing it, and so defining the same
 * key on a child reads as an override rather than a duplicate error.
 */
router.put("/:id/attributes/:key", authenticate, requireAdmin, async (req, res) => {
  const result = attributeSchema.safeParse({ ...req.body, key: req.params.key });
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const categoryId = req.params.id as string;
  const { options, ...fields } = result.data;
  const picks = fields.kind === "SELECT" || fields.kind === "MULTISELECT";

  if (picks && options.length === 0) {
    res.status(400).json({ error: "A question people pick from needs at least one option." });
    return;
  }

  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    res.status(400).json({ error: "Two options cannot have the same name." });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const saved = await tx.attributeDefinition.upsert({
        where: { categoryId_key: { categoryId, key: fields.key } },
        create: { categoryId, ...fields, unit: fields.unit ?? null },
        update: { ...fields, unit: fields.unit ?? null },
      });

      if (!picks) {
        // Turning a question into free text drops the list it used to offer, and
        // the answers with it: an option nobody can pick is not an answer anybody
        // can be shown.
        await tx.attributeOption.deleteMany({ where: { definitionId: saved.id } });
        return;
      }

      const existing = await tx.attributeOption.findMany({ where: { definitionId: saved.id } });
      const wanted = new Set(options);

      // Upserted rather than replaced wholesale, because deleting an option
      // cascades away every answer that used it.
      for (const gone of existing.filter((option) => !wanted.has(option.value))) {
        await tx.attributeOption.delete({ where: { id: gone.id } });
      }

      for (const [position, value] of options.entries()) {
        await tx.attributeOption.upsert({
          where: { definitionId_value: { definitionId: saved.id, value } },
          create: { definitionId: saved.id, value, position },
          update: { position },
        });
      }
    });

    res.json({ attributes: await effectiveAttributes(categoryId) });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Category not found",
      related: "That category does not exist",
      fallback: "Could not save this question",
    });
  }
});

/** Removes a question from the category that owns it, and every answer to it. */
router.delete("/:id/attributes/:key", authenticate, requireAdmin, async (req, res) => {
  const categoryId = req.params.id as string;

  try {
    await prisma.attributeDefinition.delete({
      where: { categoryId_key: { categoryId, key: req.params.key as string } },
    });
    res.json({ attributes: await effectiveAttributes(categoryId) });
  } catch (error) {
    handleWriteError(res, error, {
      // Trying to delete an inherited question from the category that merely
      // receives it is the likely mistake, and the row genuinely is not there.
      missing: "This category does not define that question. Remove it where it is defined.",
      fallback: "Could not remove this question",
    });
  }
});

router.get("/:slug", async (req, res) => {
  const category = await prisma.category.findUnique({ where: { slug: req.params.slug } });

  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  /**
   * Products filed anywhere at or below here.
   *
   * Asking only for the exact category empties every page above the leaves: a
   * shop that files a shirt under Tshirts has nothing to show on Men Fashion,
   * which is the page the menu actually links to.
   */
  const ids = await descendantIds(category.id);

  const [products, path] = await Promise.all([
    prisma.product.findMany({
      where: { categoryId: { in: ids }, isActive: true },
      orderBy: { createdAt: "desc" },
      include: {
        variants: { orderBy: [{ position: "asc" }, { label: "asc" }] },
        colours: { orderBy: [{ position: "asc" }, { name: "asc" }] },
      },
    }),
    ancestorsOf(category.id),
  ]);

  res.json({
    category: {
      ...serializeCategory(category),
      path: path.map((crumb) => ({ id: crumb.id, name: crumb.name, slug: crumb.slug })),
      products: serializeProducts(products),
    },
  });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = categorySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const category = await prisma.category.create({ data: result.data });
    res.status(201).json({ category });
  } catch (error) {
    handleWriteError(res, error, {
      duplicate: "A category already uses that slug",
      fallback: "Could not create this category",
    });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = categorySchema.partial().safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;

  /**
   * A category cannot be filed under itself, or under anything beneath it.
   *
   * The database has no opinion on this: both rows exist and the foreign key is
   * satisfied. What it produces is a ring floating off the tree — every category
   * in it disappears from the menu, because none of them reaches a root. The
   * walkers survive it, but only by refusing to loop forever.
   */
  if (result.data.parentId) {
    const wouldLoop = (await descendantIds(id)).includes(result.data.parentId);
    if (wouldLoop) {
      res.status(400).json({ error: "A category cannot sit inside itself." });
      return;
    }
  }

  try {
    const category = await prisma.category.update({
      where: { id },
      data: result.data,
    });
    res.json({ category: serializeCategory(category) });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Category not found",
      duplicate: "Another category already uses that slug",
      fallback: "Could not save this category",
    });
  }
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.category.delete({ where: { id } });
    res.json({ message: "Category deleted" });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Category not found",
      // Product.categoryId is a required relation, so the database refuses this
      // while anything is still filed under it. Saying "not found" here sent an
      // admin looking for a category that was in front of them.
      related: "This category still has products in it. Move or delete those first.",
      fallback: "Could not delete this category",
    });
  }
});

export default router;
