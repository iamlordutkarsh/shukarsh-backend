import { Prisma } from "@prisma/client";

/**
 * The fulfilment queues the admin panel is organised into.
 *
 * These are not order statuses. A stage answers "is this work waiting on the
 * shop", which needs the payment as well as the status: a PENDING order that was
 * never paid for is an abandoned checkout, not something to approve, and it must
 * not sit in the approval queue forever alongside orders that owe someone a
 * parcel.
 *
 * The rule lives here rather than in the panel because the panel now reads one
 * page at a time. Filtering a page in the browser would answer "pending orders
 * among the most recent hundred", and quietly report an empty queue while the
 * oldest unapproved order — the one that has waited longest — sat out of reach.
 */
export const ORDER_STAGES = [
  "PENDING",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CLOSED",
  "UNPAID",
  "ALL",
] as const;

export type OrderStage = (typeof ORDER_STAGES)[number];

export function isOrderStage(value: unknown): value is OrderStage {
  return typeof value === "string" && (ORDER_STAGES as readonly string[]).includes(value);
}

/** Cancelled and returned both mean nobody is packing anything. */
const CLOSED_STATUSES = ["CANCELLED", "RETURNED"] as const;

/**
 * Whether the money is accounted for.
 *
 * A cash order is unpaid right up until it is delivered, but it is real work
 * with a real parcel, so it belongs in the queues rather than in with the
 * checkouts nobody ever completed.
 */
const SETTLED = {
  OR: [{ paymentStatus: "PAID" as const }, { paymentMethod: "COD" as const }],
};

const NOT_SETTLED = {
  paymentStatus: { not: "PAID" as const },
  paymentMethod: { not: "COD" as const },
};

/** What to add to a query to narrow it to one stage. */
export function stageWhere(stage: OrderStage): Prisma.OrderWhereInput {
  switch (stage) {
    case "ALL":
      return {};
    case "CLOSED":
      return { status: { in: [...CLOSED_STATUSES] } };
    case "UNPAID":
      return { ...NOT_SETTLED, status: { notIn: [...CLOSED_STATUSES] } };
    default:
      return { ...SETTLED, status: stage };
  }
}

/**
 * The same rule applied to a row in hand rather than to a query.
 *
 * Used to fold the stage counts out of one grouped read. Deriving both from the
 * same switch is the point: a badge that counted by one rule while the list
 * filtered by another would send somebody looking for an order that was never
 * going to be there.
 */
export function inStage(
  order: { status: string; paymentStatus: string; paymentMethod: string },
  stage: OrderStage
): boolean {
  const closed = (CLOSED_STATUSES as readonly string[]).includes(order.status);
  const settled = order.paymentStatus === "PAID" || order.paymentMethod === "COD";

  switch (stage) {
    case "ALL":
      return true;
    case "CLOSED":
      return closed;
    case "UNPAID":
      return !settled && !closed;
    default:
      return settled && order.status === stage;
  }
}

export type StageCounts = Record<OrderStage, number>;

/**
 * How many orders sit in each queue, counted over everything rather than over a
 * page.
 *
 * One grouped read instead of seven counts. The combinations of status, payment
 * status and payment method a shop actually produces number in the dozens, so
 * folding them here costs nothing and saves six round trips on a page the admin
 * opens constantly.
 */
export function foldStageCounts(
  groups: { status: string; paymentStatus: string; paymentMethod: string; _count: { _all: number } }[]
): StageCounts {
  const counts = Object.fromEntries(ORDER_STAGES.map((stage) => [stage, 0])) as StageCounts;

  for (const group of groups) {
    for (const stage of ORDER_STAGES) {
      if (inStage(group, stage)) counts[stage] += group._count._all;
    }
  }

  return counts;
}
