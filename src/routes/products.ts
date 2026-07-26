import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { serializeProduct, serializeProducts } from "../lib/product";
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
  weightKg: z.number().positive().max(50).default(0.5),
  lengthCm: z.number().int().positive().max(200).default(15),
  breadthCm: z.number().int().positive().max(200).default(12),
  heightCm: z.number().int().positive().max(200).default(6),
  hsn: z
    .string()
    .trim()
    .max(10)
    .optional()
    .transform((value) => value || null),
  categoryId: z.string().min(1),
});

const sortOptions = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  "price-asc": { price: "asc" },
  "price-desc": { price: "desc" },
  name: { name: "asc" },
} as const;

type SortKey = keyof typeof sortOptions;

router.get("/", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
  const categoryId = req.query.categoryId as string | undefined;
  const search = req.query.search as string | undefined;
  const sortKey = req.query.sort as SortKey | undefined;
  const orderBy = sortKey && sortKey in sortOptions ? sortOptions[sortKey] : sortOptions.newest;

  const where: any = { isActive: true };
  if (categoryId) where.categoryId = categoryId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy,
      include: { category: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.product.count({ where }),
  ]);

  res.json({
    products: serializeProducts(products),
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

  res.json({ product: serializeProduct(product) });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const product = await prisma.product.create({ data: result.data });
    res.status(201).json({ product: serializeProduct(product) });
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
    res.json({ product: serializeProduct(product) });
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
