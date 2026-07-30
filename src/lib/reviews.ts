import { OrderStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma";

/**
 * Reviews, restricted to people the shop actually sent the thing to.
 *
 * A new shop's reviews are worth something only if they cannot be manufactured.
 * The gate here is not a "verified buyer" badge painted on afterwards; it is the
 * condition for a row existing at all. Every review in the table is tied to a
 * delivered order, so there is no unverified case to render, and no way to buy a
 * hundred of them.
 *
 * The shop can hide a review, but only as abuse removal, and it must say why.
 * Quietly deleting the two-star ones would leave an average that lies, which is
 * also exactly what disqualifies a site from showing stars in search results.
 */

/** Comments longer than this are essays, and are nearly always pasted spam. */
const MAX_COMMENT = 1200;

export const reviewInputSchema = z.object({
  productId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .max(MAX_COMMENT)
    .optional()
    .transform((value) => value || null),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const hideInputSchema = z.object({
  /**
   * Required, and stored. Forcing the shop to name the abuse is the only thing
   * standing between "removed abuse" and "removed criticism", and it is what
   * makes the decision reviewable later.
   */
  reason: z.string().trim().min(3).max(200),
});

export interface SerializedReview {
  id: string;
  productId: string;
  rating: number;
  comment: string | null;
  /** A first name and an initial. Enough to read as a person, not a full identity. */
  author: string;
  createdAt: Date;
  updatedAt: Date;
  /** Admin listings only. Shoppers never see a hidden review at all. */
  hiddenAt?: Date | null;
  hiddenReason?: string | null;
}

export interface RatingSummary {
  count: number;
  /** Rounded to one decimal. Null when nobody has reviewed yet. */
  average: number | null;
}

export const EMPTY_RATING: RatingSummary = { count: 0, average: null };

/**
 * One decimal, because that is what a row of stars can show.
 *
 * Whole numbers would print four stars for a product rated four and a half, and
 * the raw average is a recurring decimal often enough to look like a bug.
 */
export function roundRating(average: number | null): number | null {
  if (average == null) return null;
  return Math.round(average * 10) / 10;
}

/**
 * Names a reviewer without publishing them.
 *
 * A full name plus a public opinion is more than someone signed up for, and the
 * email is never a candidate. First name and a surname initial is what a shop
 * assistant would say out loud.
 */
export function displayName(user: { firstName?: string | null; lastName?: string | null }): string {
  const first = user.firstName?.trim();
  const last = user.lastName?.trim();
  if (!first) return "Shukarsh customer";
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

export function serializeReview(
  review: any,
  options?: { includeHidden?: boolean }
): SerializedReview {
  const serialized: SerializedReview = {
    id: review.id,
    productId: review.productId,
    rating: review.rating,
    comment: review.comment,
    author: displayName(review.user ?? {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };

  if (options?.includeHidden) {
    serialized.hiddenAt = review.hiddenAt;
    serialized.hiddenReason = review.hiddenReason;
  }

  return serialized;
}

/**
 * The order that entitles this person to review this product, or null.
 *
 * Delivered, not merely paid. Reviewing something still in a van is guessing,
 * and a review posted before arrival is the one most likely to be about the
 * courier rather than the product.
 *
 * A cancelled or returned order does not count even though it may once have been
 * delivered: RETURNED means the goods went back, and the strongest opinion is
 * already recorded in the return itself.
 */
export async function findQualifyingOrder(
  userId: string,
  productId: string
): Promise<{ id: string; deliveredAt: Date | null } | null> {
  return prisma.order.findFirst({
    where: {
      userId,
      status: OrderStatus.DELIVERED,
      items: { some: { productId } },
    },
    // The earliest delivery is what earned the right, and it dates the opinion
    // honestly if they later buy the same thing again.
    orderBy: { createdAt: "asc" },
    select: { id: true, deliveredAt: true },
  });
}

/**
 * Counts and averages for a set of products, hidden reviews excluded.
 *
 * One grouped query for a whole catalogue page rather than one per card. The
 * average is computed by the database over all matching rows, so it does not
 * quietly become the average of one page of them.
 */
export async function ratingSummaries(
  productIds: string[]
): Promise<Map<string, RatingSummary>> {
  const summaries = new Map<string, RatingSummary>();
  if (productIds.length === 0) return summaries;

  const groups = await prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds }, hiddenAt: null },
    _count: { _all: true },
    _avg: { rating: true },
  });

  for (const group of groups) {
    const count = group._count._all;
    summaries.set(group.productId, {
      count,
      average: roundRating(count > 0 ? group._avg.rating : null),
    });
  }

  return summaries;
}

export async function ratingSummary(productId: string): Promise<RatingSummary> {
  const summaries = await ratingSummaries([productId]);
  return summaries.get(productId) ?? EMPTY_RATING;
}

/** What a shopper is allowed to see, in the order they would read it. */
export const publicReviewQuery = {
  where: { hiddenAt: null },
  orderBy: [{ createdAt: "desc" }] as const,
  include: { user: { select: { firstName: true, lastName: true } } },
} satisfies Prisma.ReviewFindManyArgs;
