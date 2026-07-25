import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
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
    res.status(409).json({ error: "Slug already exists" });
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
    res.status(404).json({ error: "Category not found" });
  }
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.category.delete({ where: { id } });
    res.json({ message: "Category deleted" });
  } catch (error) {
    res.status(404).json({ error: "Category not found" });
  }
});

export default router;
