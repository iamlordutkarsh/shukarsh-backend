import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const productSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  comparePrice: z.number().positive().optional(),
  stock: z.number().int().min(0).default(0),
  images: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  categoryId: z.string().min(1),
});

router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
  const categoryId = req.query.categoryId as string | undefined;
  const search = req.query.search as string | undefined;

  const where: any = { isActive: true };
  if (categoryId) where.categoryId = categoryId;
  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { category: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.product.count({ where }),
  ]);

  res.json({
    products,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

router.get("/:slug", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });

  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json({ product });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const product = await prisma.product.create({ data: result.data });
    res.status(201).json({ product });
  } catch (error) {
    res.status(409).json({ error: "Slug already exists or invalid category" });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.partial().safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;

  try {
    const product = await prisma.product.update({
      where: { id },
      data: result.data,
    });
    res.json({ product });
  } catch (error) {
    res.status(404).json({ error: "Product not found" });
  }
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.product.delete({ where: { id } });
    res.json({ message: "Product deleted" });
  } catch (error) {
    res.status(404).json({ error: "Product not found" });
  }
});

export default router;
