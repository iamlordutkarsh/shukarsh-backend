import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Anything that can run a query: the client itself or a transaction handle.
 *
 * Stock has to move in the same transaction as whatever caused it, or a failure
 * halfway leaves the shelf and the reason for it disagreeing.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export type StockReason =
  | "INITIAL"
  | "SALE"
  | "CANCELLATION"
  | "REOPEN"
  | "RETURN_RESTOCK"
  | "RECEIVED"
  | "CORRECTION"
  | "DAMAGE";

/** The reasons a person may choose. The rest are written by the shop itself. */
export const MANUAL_REASONS: StockReason[] = ["RECEIVED", "CORRECTION", "DAMAGE"];

export interface StockMoveInput {
  productId: string;
  /** Signed. Positive puts units on the shelf, negative takes them off. */
  delta: number;
  reason: StockReason;
  note?: string | null;
  /** The admin who did it, when one did. */
  userId?: string | null;
  orderId?: string | null;
  /**
   * Take the units even if the shelf cannot cover them.
   *
   * Only for a sale that has already been paid for. Everywhere else, refusing is
   * the correct answer; there, the money has arrived and declining to record it
   * would lose the sale rather than prevent it.
   */
  allowNegative?: boolean;
}

/** Thrown when a movement would leave the shelf holding less than nothing. */
export class NotEnoughStockError extends Error {
  productId: string;

  constructor(productId: string) {
    super("Not enough stock");
    this.name = "NotEnoughStockError";
    this.productId = productId;
  }
}

/**
 * Moves stock and records why, together.
 *
 * Taking units is conditional on there being enough, which is what stops the same
 * last dress being promised to two people; a caller that would go negative gets
 * NotEnoughStockError rather than a silent no-op. Returns the new balance.
 */
export async function moveStock(db: Db, input: StockMoveInput): Promise<number> {
  if (!Number.isInteger(input.delta)) {
    throw new Error("A stock movement has to be a whole number of units");
  }

  if (input.delta === 0) {
    throw new Error("A stock movement of nothing is not a movement");
  }

  let balance: number;

  if (input.delta > 0 || input.allowNegative) {
    const updated = await db.product.update({
      where: { id: input.productId },
      data: { stock: { increment: input.delta } },
      select: { stock: true },
    });
    balance = updated.stock;
  } else {
    const needed = -input.delta;
    const taken = await db.product.updateMany({
      where: { id: input.productId, stock: { gte: needed } },
      data: { stock: { decrement: needed } },
    });

    if (taken.count === 0) throw new NotEnoughStockError(input.productId);

    // updateMany cannot return the row, and the balance is worth having on the
    // ledger line: reading it back inside the same transaction sees our own write.
    const after = await db.product.findUnique({
      where: { id: input.productId },
      select: { stock: true },
    });
    balance = after?.stock ?? 0;
  }

  await db.stockMove.create({
    data: {
      productId: input.productId,
      delta: input.delta,
      balance,
      reason: input.reason as never,
      note: input.note?.trim() || null,
      userId: input.userId ?? null,
      orderId: input.orderId ?? null,
    },
  });

  return balance;
}

/** What a ledger says the shelf should hold. */
export function balanceFrom(moves: { delta: number }[]): number {
  return moves.reduce((total, move) => total + move.delta, 0);
}

export const LOW_STOCK_DEFAULT = 5;

export function isLowStock(product: { stock: number; lowStockThreshold?: number | null }): boolean {
  return product.stock <= (product.lowStockThreshold ?? LOW_STOCK_DEFAULT);
}

/**
 * What needs reordering, most urgent first.
 *
 * Compares two columns of the same row, which Prisma will do with a field
 * reference. Switched-off products are left out: nobody is going to restock
 * something that is not for sale.
 */
export async function lowStockProducts(limit = 50) {
  return prisma.product.findMany({
    where: {
      isActive: true,
      stock: { lte: prisma.product.fields.lowStockThreshold },
    },
    orderBy: [{ stock: "asc" }, { name: "asc" }],
    take: limit,
    select: { id: true, name: true, slug: true, stock: true, lowStockThreshold: true },
  });
}

export function serializeStockMove(move: any) {
  return {
    id: move.id,
    delta: move.delta,
    balance: move.balance,
    reason: move.reason,
    note: move.note ?? null,
    orderId: move.orderId ?? null,
    by: move.user ? [move.user.firstName, move.user.lastName].filter(Boolean).join(" ") || null : null,
    createdAt: move.createdAt,
  };
}
