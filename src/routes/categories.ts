import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { serializeProducts } from "../lib/product";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  image: z.string().optional(),
  parentId: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const categories = await prisma.category.findMany({
    orderBy: { name: "asc" },
    include: { children: true },
  });
  res.json({ categories });
});

router.get("/:slug", async (req, res) => {
  const category = await prisma.category.findUnique({
    where: { slug: req.params.slug },
    include: {
      products: {
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!category) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  res.json({ category: { ...category, products: serializeProducts(category.products) } });
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

  try {
    const category = await prisma.category.update({
      where: { id },
      data: result.data,
    });
    res.json({ category });
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
