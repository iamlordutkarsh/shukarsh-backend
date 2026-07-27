import { Router } from "express";
import { z } from "zod";
import { CouponType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { normalizeCode } from "../lib/coupon";
import { buildQuote } from "../lib/quote";
import { verifyToken } from "../lib/auth";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const couponFields = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, hyphens and underscores only")
      .transform(normalizeCode),
    description: z.string().trim().max(160).optional(),
    type: z.nativeEnum(CouponType),
    value: z.number().min(0).default(0),
    maxDiscount: z.number().positive().optional(),
    minOrderValue: z.number().min(0).default(0),
    usageLimit: z.number().int().positive().nullable().optional(),
    perUserLimit: z.number().int().positive().nullable().optional(),
    firstOrderOnly: z.boolean().default(false),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
    categoryIds: z.array(z.string().min(1)).default([]),
    productIds: z.array(z.string().min(1)).default([]),
  });

/**
 * Shared by create and update, so both have to be tolerant of a field being
 * absent: on an update the admin may only be changing the expiry.
 */
function checkCoupon(
  data: {
    type?: CouponType;
    value?: number;
    startsAt?: Date | null;
    expiresAt?: Date | null;
  },
  ctx: z.RefinementCtx
) {
  if (data.type === "PERCENT" && data.value != null && (data.value <= 0 || data.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "A percent must be between 1 and 100" });
  }
  if (data.type === "FLAT" && data.value != null && data.value <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "A flat discount needs an amount" });
  }
  if (data.startsAt && data.expiresAt && data.startsAt >= data.expiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "The end has to come after the start" });
  }
}

const couponSchema = couponFields.superRefine(checkCoupon);
const couponUpdateSchema = couponFields.partial().superRefine(checkCoupon);

const applySchema = z.object({
  code: z.string().trim().min(1).max(40),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive().max(20),
      })
    )
    .min(1),
  email: z.string().email().optional(),
});

function serializeCoupon(coupon: any) {
  const { categories, products, _count, ...rest } = coupon;

  return {
    ...rest,
    value: Number(coupon.value),
    maxDiscount: coupon.maxDiscount != null ? Number(coupon.maxDiscount) : null,
    minOrderValue: Number(coupon.minOrderValue),
    categoryIds: (categories ?? []).map((row: any) => row.categoryId),
    productIds: (products ?? []).map((row: any) => row.productId),
    // Names travel with the ids so the admin form can show what a saved coupon
    // targets without having to look every product up again.
    products: (products ?? []).map((row: any) => ({
      id: row.product.id,
      name: row.product.name,
    })),
    redemptionCount: _count?.redemptions ?? 0,
  };
}

const couponInclude = {
  categories: { select: { categoryId: true } },
  products: { select: { productId: true, product: { select: { id: true, name: true } } } },
  _count: { select: { redemptions: true } },
} as const;

/**
 * Checks a code against a real bag and says what it is worth.
 *
 * Deliberately runs the whole quote rather than looking the coupon up on its
 * own, so the discount shown here is produced by the same code that will charge
 * the card. Shipping and GST are left out of the answer because the checkout
 * page asks for those separately once it knows the address.
 */
router.post("/apply", async (req, res) => {
  const result = applySchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { code, items, email } = result.data;

  const header = req.headers.authorization;
  let userId: string | undefined;
  if (header?.startsWith("Bearer ")) {
    try {
      userId = verifyToken(header.slice(7)).id;
    } catch {
      userId = undefined;
    }
  }

  try {
    const quote = await buildQuote({ items, couponCode: code, userId, email });

    if (!quote.coupon) {
      res.status(422).json({ ok: false, error: quote.couponError ?? "That code cannot be used." });
      return;
    }

    res.json({
      ok: true,
      coupon: {
        code: quote.coupon.code,
        type: quote.coupon.type,
        description: quote.coupon.description,
        discount: quote.coupon.discount,
        freeShipping: quote.coupon.freeShipping,
      },
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      res.status(statusCode).json({ error: (error as Error).message });
      return;
    }

    console.error("Coupon apply failed:", error);
    res.status(500).json({ error: "Could not check that code" });
  }
});

router.get("/", authenticate, requireAdmin, async (_req, res) => {
  const coupons = await prisma.coupon.findMany({
    orderBy: { createdAt: "desc" },
    include: couponInclude,
  });

  res.json({ coupons: coupons.map(serializeCoupon) });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = couponSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { categoryIds, productIds, ...data } = result.data;

  try {
    const coupon = await prisma.coupon.create({
      data: {
        ...data,
        categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        products: { create: productIds.map((productId) => ({ productId })) },
      },
      include: couponInclude,
    });

    res.status(201).json({ coupon: serializeCoupon(coupon) });
  } catch (error) {
    res.status(409).json({ error: "That code already exists, or a category or product is unknown" });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = couponUpdateSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;
  const { categoryIds, productIds, ...data } = result.data;

  try {
    const coupon = await prisma.$transaction(async (tx) => {
      // Targeting is replaced wholesale rather than merged, so clearing every
      // category in the admin form actually clears them.
      if (categoryIds) {
        await tx.couponCategory.deleteMany({ where: { couponId: id } });
        await tx.couponCategory.createMany({
          data: categoryIds.map((categoryId) => ({ couponId: id, categoryId })),
        });
      }

      if (productIds) {
        await tx.couponProduct.deleteMany({ where: { couponId: id } });
        await tx.couponProduct.createMany({
          data: productIds.map((productId) => ({ couponId: id, productId })),
        });
      }

      return tx.coupon.update({ where: { id }, data, include: couponInclude });
    });

    res.json({ coupon: serializeCoupon(coupon) });
  } catch (error) {
    res.status(404).json({ error: "Coupon not found, or that code is taken" });
  }
});

/**
 * Deactivates rather than deletes once a code has been used. Redemptions are
 * what an order's discount is evidenced by, and a deleted coupon would cascade
 * them away and leave paid orders with a discount nothing accounts for.
 */
router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    const used = await prisma.couponRedemption.count({ where: { couponId: id } });

    if (used > 0) {
      const coupon = await prisma.coupon.update({
        where: { id },
        data: { isActive: false },
        include: couponInclude,
      });

      res.json({
        coupon: serializeCoupon(coupon),
        deactivated: true,
        message: "This code has been used, so it was switched off rather than deleted.",
      });
      return;
    }

    await prisma.coupon.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (error) {
    res.status(404).json({ error: "Coupon not found" });
  }
});

export default router;
