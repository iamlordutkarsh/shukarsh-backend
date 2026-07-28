import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { serializeProduct, serializeProducts } from "../lib/product";
import { GST_RATES, defaultGstRate } from "../lib/tax";
import { authenticate, isAdminRequest, requireAdmin } from "../middleware/auth";

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
  // Left optional so the create handler can fall back to GST_DEFAULT_RATE at
  // request time. A zod .default() would read the env at import, which happens
  // before dotenv has run.
  gstRate: z
    .number()
    .refine((value) => GST_RATES.includes(value as (typeof GST_RATES)[number]), {
      message: `GST rate must be one of ${GST_RATES.join(", ")}`,
    })
    .optional(),
  // Net of GST: input tax credit means the tax paid to a supplier is not a cost.
  costPrice: z.number().min(0).nullable().optional(),
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

/**
 * These reads answer differently for an admin, who gets costPrice back. The only
 * thing telling the two bodies apart is a request header, so the response has to
 * say so: a CDN or proxy keying on the URL alone would otherwise be free to
 * store an admin's answer and serve supplier costs to shoppers.
 */
function perCaller(_req: Request, res: Response, next: NextFunction) {
  res.vary("Authorization");
  res.setHeader("Cache-Control", "private, no-store");
  next();
}

router.get("/", perCaller, async (req, res) => {
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
    // The admin catalogue reads this same endpoint, so cost comes back for an
    // admin and is dropped for everyone else.
    products: serializeProducts(products, { includeCost: isAdminRequest(req) }),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

router.get("/:slug", perCaller, async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug as string },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });

  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json({ product: serializeProduct(product, { includeCost: isAdminRequest(req) }) });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const product = await prisma.product.create({
      data: { ...result.data, gstRate: result.data.gstRate ?? defaultGstRate() },
    });
    res.status(201).json({ product: serializeProduct(product, { includeCost: true }) });
  } catch {
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
    res.json({ product: serializeProduct(product, { includeCost: true }) });
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.product.delete({ where: { id } });
    res.json({ message: "Product deleted" });
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

export default router;
