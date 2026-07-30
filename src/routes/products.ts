import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { serializeProduct, serializeProducts } from "../lib/product";
import {
  LOW_STOCK_DEFAULT,
  NotEnoughStockError,
  moveStock,
  serializeStockMove,
} from "../lib/inventory";
import { ratingSummaries, ratingSummary } from "../lib/reviews";
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
  lowStockThreshold: z.number().int().min(0).max(1000).default(LOW_STOCK_DEFAULT),
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

const stockAdjustSchema = z.object({
  /** Signed and never zero: this endpoint states a movement, not a total. */
  delta: z.number().int().min(-10000).max(10000).refine((value) => value !== 0, {
    message: "Say how many units to add or take away",
  }),
  reason: z.enum(["RECEIVED", "CORRECTION", "DAMAGE"]),
  note: z.string().trim().max(200).optional(),
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

  // One grouped query for the whole page, after the page is known. Asking per
  // card would be twelve round trips, and this database is behind a pooler that
  // has already been exhausted once by a fan of concurrent reads.
  const ratings = await ratingSummaries(products.map((product) => product.id));

  res.json({
    // The admin catalogue reads this same endpoint, so cost comes back for an
    // admin and is dropped for everyone else.
    products: serializeProducts(products, { includeCost: isAdminRequest(req), ratings }),
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

  const rating = await ratingSummary(product.id);

  res.json({ product: serializeProduct(product, { includeCost: isAdminRequest(req), rating }) });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const opening = result.data.stock;

    const product = await prisma.$transaction(async (tx) => {
      // Created empty and then filled through the ledger, so the number on the
      // shelf is the sum of its movements from the very first one. A product that
      // starts at 12 with nothing to say why is exactly the gap this closes.
      const created = await tx.product.create({
        data: { ...result.data, stock: 0, gstRate: result.data.gstRate ?? defaultGstRate() },
      });

      if (opening > 0) {
        await moveStock(tx, {
          productId: created.id,
          delta: opening,
          reason: "INITIAL",
          userId: req.user!.id,
        });
      }

      return { ...created, stock: opening };
    });

    res.status(201).json({ product: serializeProduct(product, { includeCost: true }) });
  } catch (error) {
    handleWriteError(res, error, {
      duplicate: "A product already uses that slug",
      related: "That category does not exist",
      fallback: "Could not create this product",
    });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.partial().safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;
  // Handled separately below: writing it straight would move the shelf with no
  // record of why, which is the one thing the ledger exists to prevent.
  const { stock: wantedStock, ...fields } = result.data;

  try {
    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id }, data: fields });

      if (wantedStock === undefined || wantedStock === updated.stock) return updated;

      // A form posts where the count should end up, not by how much it moved, so
      // the difference is worked out here and recorded as a correction.
      const balance = await moveStock(tx, {
        productId: id,
        delta: wantedStock - updated.stock,
        reason: "CORRECTION",
        note: "Set from the product form",
        userId: req.user!.id,
        allowNegative: true,
      });

      return { ...updated, stock: balance };
    });

    res.json({ product: serializeProduct(product, { includeCost: true }) });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Product not found",
      duplicate: "Another product already uses that slug",
      related: "That category does not exist",
      fallback: "Could not save this product",
    });
  }
});

/**
 * Moves stock by a difference rather than to a total.
 *
 * Two people receiving stock at once both add what they added. A form that posts
 * the total silently discards whichever save lands second, along with the sale
 * that happened in between.
 */
router.post("/:id/stock", authenticate, requireAdmin, async (req, res) => {
  const result = stockAdjustSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const id = req.params.id as string;

  try {
    const product = await prisma.$transaction(async (tx) => {
      const balance = await moveStock(tx, {
        productId: id,
        delta: result.data.delta,
        reason: result.data.reason,
        note: result.data.note,
        userId: req.user!.id,
        // A recount says what is really there, so it is allowed to contradict us.
        allowNegative: result.data.reason === "CORRECTION",
      });

      const updated = await tx.product.findUnique({
        where: { id },
        include: { category: { select: { id: true, name: true, slug: true } } },
      });

      return { updated, balance };
    });

    if (!product.updated) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ product: serializeProduct(product.updated, { includeCost: true }) });
  } catch (error) {
    if (error instanceof NotEnoughStockError) {
      res.status(409).json({ error: "There are not that many on the shelf to take away." });
      return;
    }

    handleWriteError(res, error, {
      missing: "Product not found",
      fallback: "Could not adjust the stock",
    });
  }
});

/** Where the stock went, newest first. */
router.get("/:id/stock-moves", authenticate, requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));

  const moves = await prisma.stockMove.findMany({
    where: { productId: req.params.id as string },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { firstName: true, lastName: true } } },
  });

  res.json({ moves: moves.map(serializeStockMove) });
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.product.delete({ where: { id } });
    res.json({ message: "Product deleted" });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Product not found",
      // OrderItem points here so an invoice can still name what was bought, and
      // the database will not let that history be broken. Switching the product
      // off is the way to retire it.
      related: "This product has orders against it. Switch it off instead of deleting it.",
      fallback: "Could not delete this product",
    });
  }
});

export default router;
