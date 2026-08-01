import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { serializeProducts } from "../lib/product";
import { authenticate } from "../middleware/auth";

const router = Router();

/**
 * Enough for serializeProduct to tell the truth about what is buyable.
 *
 * Without the options it returns `variants: []`, which reads as "sells as one
 * thing" rather than "this query did not ask": a card then quotes the base price
 * for something every cell overrides, hides the swatches, and its one-tap add
 * puts a line in the bag with no size that checkout refuses.
 */
const productSelect: Prisma.ProductSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  price: true,
  comparePrice: true,
  stock: true,
  images: true,
  isActive: true,
  categoryId: true,
  createdAt: true,
  category: { select: { id: true, name: true, slug: true } },
  variants: { orderBy: [{ position: "asc" }, { label: "asc" }] },
  colours: { orderBy: [{ position: "asc" }, { name: "asc" }] },
};

const addSchema = z.object({ productId: z.string().min(1) });
const mergeSchema = z.object({ productIds: z.array(z.string().min(1)).max(200) });

async function listWishlist(userId: string) {
  const items = await prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { product: { select: productSelect } },
  });

  return serializeProducts(items.filter((item) => item.product.isActive).map((item) => item.product));
}

router.get("/", authenticate, async (req, res) => {
  const products = await listWishlist(req.user!.id);
  res.json({ products });
});

router.post("/", authenticate, async (req, res) => {
  const result = addSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "A productId is required" });
    return;
  }

  try {
    await prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: req.user!.id, productId: result.data.productId } },
      update: {},
      create: { userId: req.user!.id, productId: result.data.productId },
    });
  } catch {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const products = await listWishlist(req.user!.id);
  res.json({ products });
});

router.delete("/:productId", authenticate, async (req, res) => {
  await prisma.wishlistItem.deleteMany({
    where: { userId: req.user!.id, productId: req.params.productId as string },
  });

  const products = await listWishlist(req.user!.id);
  res.json({ products });
});

/** Folds a guest's local wishlist into the account on sign in. */
router.post("/merge", authenticate, async (req, res) => {
  const result = mergeSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "productIds must be an array of ids" });
    return;
  }

  const unique = Array.from(new Set(result.data.productIds));
  if (unique.length > 0) {
    const existing = await prisma.product.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });

    await prisma.wishlistItem.createMany({
      data: existing.map((product) => ({ userId: req.user!.id, productId: product.id })),
      skipDuplicates: true,
    });
  }

  const products = await listWishlist(req.user!.id);
  res.json({ products });
});

export default router;
