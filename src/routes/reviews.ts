import { Router } from "express";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { authenticate, requireAdmin } from "../middleware/auth";
import { reviewLimiter } from "../middleware/rate-limit";
import {
  findQualifyingOrder,
  hideInputSchema,
  publicReviewQuery,
  ratingSummary,
  reviewInputSchema,
  serializeReview,
} from "../lib/reviews";

const router = Router();

/**
 * Public reviews for one product.
 *
 * Hidden rows are filtered in the query rather than after it, so a paging bug
 * can never leak one, and the count sent alongside is over the same set the list
 * came from.
 */
router.get("/", async (req, res) => {
  const productId = (req.query.productId as string | undefined)?.trim();
  if (!productId) {
    res.status(400).json({ error: "Which product?" });
    return;
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));

  const [reviews, summary] = await Promise.all([
    prisma.review.findMany({
      ...publicReviewQuery,
      where: { ...publicReviewQuery.where, productId },
      skip: (page - 1) * limit,
      take: limit,
    }),
    ratingSummary(productId),
  ]);

  // Short and public: the same answer for everyone, and a minute stale is
  // nobody's problem. Written explicitly because a signed-in shopper's request
  // carries an Authorization header and would otherwise be treated as private.
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({
    reviews: reviews.map((review) => serializeReview(review)),
    summary,
    pagination: { page, limit, total: summary.count, pages: Math.ceil(summary.count / limit) },
  });
});

/**
 * Whether the signed-in shopper may review this product, and what they already
 * said.
 *
 * The form asks before it renders, because "write a review" on something you
 * cannot review is a dead end, and explaining the rule afterwards in an error
 * reads as a refusal.
 */
router.get("/mine", authenticate, async (req, res) => {
  const productId = (req.query.productId as string | undefined)?.trim();
  if (!productId) {
    res.status(400).json({ error: "Which product?" });
    return;
  }

  const [existing, order] = await Promise.all([
    prisma.review.findUnique({
      where: { userId_productId: { userId: req.user!.id, productId } },
      include: { user: { select: { firstName: true, lastName: true } } },
    }),
    findQualifyingOrder(req.user!.id, productId),
  ]);

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    canReview: Boolean(order),
    // Their own review comes back with its hidden state. Someone whose review was
    // taken down is owed the reason, not a blank form that silently changes
    // nothing.
    review: existing ? serializeReview(existing, { includeHidden: true }) : null,
  });
});

/**
 * Writes the shopper's review of a product they were sent.
 *
 * One row per person per product, so posting again edits rather than stacks. An
 * upsert is what makes the second press of a slow button harmless.
 */
router.post("/", authenticate, reviewLimiter, async (req, res) => {
  const result = reviewInputSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { productId, rating, comment } = result.data;
  const order = await findQualifyingOrder(req.user!.id, productId);

  if (!order) {
    res.status(403).json({
      error: "Reviews are open to customers we have delivered this to.",
    });
    return;
  }

  try {
    const review = await prisma.review.upsert({
      where: { userId_productId: { userId: req.user!.id, productId } },
      // hiddenAt is deliberately absent from the update. Editing a review the
      // shop removed for abuse must not put it back up.
      update: { rating, comment },
      create: { userId: req.user!.id, productId, rating, comment, orderId: order.id },
      include: { user: { select: { firstName: true, lastName: true } } },
    });

    res.status(201).json({ review: serializeReview(review, { includeHidden: true }) });
  } catch (error) {
    handleWriteError(res, error, {
      related: "That product no longer exists",
      fallback: "Could not save your review",
    });
  }
});

/** Withdraws the shopper's own review. */
router.delete("/:id", authenticate, async (req, res) => {
  const id = req.params.id as string;
  const review = await prisma.review.findUnique({ where: { id }, select: { userId: true } });

  // Absent and someone else's answer the same way, so this cannot be used to
  // find out whether an id exists.
  if (!review || review.userId !== req.user!.id) {
    res.status(404).json({ error: "Review not found" });
    return;
  }

  await prisma.review.delete({ where: { id } });
  res.json({ message: "Review removed" });
});

/** Everything, hidden included, for the moderation screen. */
router.get("/admin/all", authenticate, requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));

  const reviews = await prisma.review.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { firstName: true, lastName: true } },
      product: { select: { id: true, name: true, slug: true } },
    },
  });

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    reviews: reviews.map((review) => ({
      ...serializeReview(review, { includeHidden: true }),
      product: review.product,
    })),
  });
});

/**
 * Takes a review down, on the record.
 *
 * Hidden rather than deleted, and never without a reason. The shop needs a way
 * to remove abuse, obvious spam, and someone else's phone number; it does not
 * need a way to remove a fair complaint, and a stored reason is what tells those
 * two apart when anyone looks back.
 */
router.post("/:id/hide", authenticate, requireAdmin, async (req, res) => {
  const result = hideInputSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Say why this is being taken down." });
    return;
  }

  try {
    const review = await prisma.review.update({
      where: { id: req.params.id as string },
      data: { hiddenAt: new Date(), hiddenReason: result.data.reason },
      include: {
        user: { select: { firstName: true, lastName: true } },
        product: { select: { id: true, name: true, slug: true } },
      },
    });

    res.json({ review: { ...serializeReview(review, { includeHidden: true }), product: review.product } });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Review not found",
      fallback: "Could not hide this review",
    });
  }
});

router.post("/:id/unhide", authenticate, requireAdmin, async (req, res) => {
  try {
    const review = await prisma.review.update({
      where: { id: req.params.id as string },
      data: { hiddenAt: null, hiddenReason: null },
      include: {
        user: { select: { firstName: true, lastName: true } },
        product: { select: { id: true, name: true, slug: true } },
      },
    });

    res.json({ review: { ...serializeReview(review, { includeHidden: true }), product: review.product } });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Review not found",
      fallback: "Could not restore this review",
    });
  }
});

export default router;
