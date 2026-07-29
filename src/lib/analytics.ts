import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * India has no daylight saving, so its offset is a constant and a day boundary
 * can be worked out arithmetically. A shop day runs midnight to midnight in Delhi,
 * not in UTC, or the last five and a half hours of every day land on tomorrow.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Midnight IST, `daysAgo` days back, as a UTC instant. */
export function shopDayStart(daysAgo: number, now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export const WINDOWS = [7, 30, 90] as const;

export function windowDays(raw: unknown): number {
  const days = Number(raw);
  return WINDOWS.includes(days as (typeof WINDOWS)[number]) ? days : 30;
}

function num(value: Prisma.Decimal | number | null | undefined): number {
  return value == null ? 0 : Number(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Profit on sales net of GST.
 *
 * Prices here are tax-inclusive, so comparing what the customer paid against what
 * the goods cost counts the tax as profit. It is not: it belongs to the
 * government. Costs are recorded net of GST for the same reason, since input tax
 * credit means the tax paid to a supplier was never really a cost either.
 */
export function marginOf(netSales: number, cost: number): { profit: number; percent: number } {
  const profit = netSales - cost;
  return {
    profit: round2(profit),
    percent: netSales > 0 ? round2((profit / netSales) * 100) : 0,
  };
}

/**
 * Orders that count as money taken.
 *
 * Paid, and not since called off: a cancelled order that was paid for is a refund
 * waiting to happen, not revenue. Dated by when the money arrived, falling back to
 * when the order was placed for anything paid before paidAt existed. Those two are
 * minutes apart in practice, and guessing here only moves a sale between
 * neighbouring days rather than inventing one.
 */
function paidIn(from: Date): Prisma.OrderWhereInput {
  return {
    paymentStatus: "PAID",
    status: { notIn: ["CANCELLED", "RETURNED"] },
    OR: [{ paidAt: { gte: from } }, { paidAt: null, createdAt: { gte: from } }],
  };
}

export interface AnalyticsSummary {
  days: number;
  from: string;
  money: {
    revenue: number;
    orders: number;
    averageOrder: number;
    /** GST inside the revenue above, not on top of it. */
    gstCollected: number;
    discountGiven: number;
    deliveryCharged: number;
    refunded: number;
  };
  margin: {
    /** Sales net of GST, which is what a cost net of GST can be compared with. */
    netSales: number;
    cost: number;
    profit: number;
    percent: number;
    /** Share of units sold whose cost we actually know, 0 to 1. */
    coverage: number;
  };
  funnel: {
    bagsStarted: number;
    checkoutsStarted: number;
    paid: number;
    abandonRate: number;
  };
  daily: { day: string; revenue: number; orders: number }[];
  topProducts: { id: string; name: string; slug: string; units: number; revenue: number }[];
  deadStock: { id: string; name: string; slug: string; stock: number }[];
  returns: { units: number; rate: number; damaged: number; wrongItem: number };
  stock: { onShelf: number; valueAtCost: number; lowCount: number };
}

/**
 * Every number the dashboard shows, in one pass.
 *
 * Aggregated in the database rather than by pulling orders into memory: this runs
 * on every visit to the page, and a shop that does well is exactly the one where
 * loading every order to add it up stops working.
 */
export async function analyticsSummary(days: number): Promise<AnalyticsSummary> {
  const from = shopDayStart(days - 1);
  const paidWhere = paidIn(from);

  const [totals, items, costRows, bags, checkouts, daily, top, returned, stockRows] =
    await Promise.all([
      prisma.order.aggregate({
        where: paidWhere,
        _sum: {
          totalAmount: true,
          taxTotal: true,
          discountTotal: true,
          shippingAmount: true,
        },
        _count: { _all: true },
      }),

      prisma.orderItem.aggregate({
        where: { order: paidWhere },
        _sum: { taxableAmount: true, quantity: true },
      }),

      // Cost has to be weighted by quantity, which an aggregate cannot do, so the
      // lines come back and are folded here. Only the columns needed, and only for
      // paid orders inside the window.
      prisma.orderItem.findMany({
        where: { order: paidWhere },
        select: { quantity: true, costPrice: true },
      }),

      // A bag counts as started when something was put in it, not when the cart row
      // was made: a returning customer reuses one cart forever.
      prisma.cartItem
        .findMany({
          where: { createdAt: { gte: from } },
          distinct: ["cartId"],
          select: { cartId: true },
        })
        .then((rows) => rows.length),

      prisma.order.count({ where: { createdAt: { gte: from } } }),

      prisma.$queryRaw<{ day: Date; revenue: Prisma.Decimal; orders: bigint }[]>`
        SELECT date_trunc('day', COALESCE("paidAt", "createdAt") AT TIME ZONE 'Asia/Kolkata') AS day,
               SUM("totalAmount") AS revenue,
               COUNT(*) AS orders
        FROM "Order"
        WHERE "paymentStatus" = 'PAID'
          AND "status" NOT IN ('CANCELLED', 'RETURNED')
          AND COALESCE("paidAt", "createdAt") >= ${from}
        GROUP BY 1
        ORDER BY 1
      `,

      prisma.orderItem.groupBy({
        by: ["productId"],
        where: { order: paidWhere },
        _sum: { quantity: true, taxableAmount: true },
        orderBy: { _sum: { quantity: "desc" } },
        take: 8,
      }),

      prisma.returnItem.findMany({
        where: {
          returnRequest: {
            status: { in: ["RECEIVED", "COMPLETED"] },
            createdAt: { gte: from },
          },
        },
        select: { quantity: true, returnRequest: { select: { reason: true } } },
      }),

      prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, stock: true, costPrice: true, lowStockThreshold: true },
      }),
    ]);

  const revenue = num(totals._sum.totalAmount);
  const orders = totals._count._all;

  const netSales = num(items._sum.taxableAmount);
  let cost = 0;
  let costedUnits = 0;
  for (const line of costRows) {
    if (line.costPrice == null) continue;
    cost += Number(line.costPrice) * line.quantity;
    costedUnits += line.quantity;
  }
  const unitsSold = items._sum.quantity ?? 0;
  const margin = marginOf(netSales, cost);

  const productIds = top.map((row) => row.productId);
  const named = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const nameOf = new Map(named.map((product) => [product.id, product]));

  // Anything on the shelf that has not sold once in the window. The point is what
  // to stop reordering, so switched-off products and empty shelves are not it.
  const dead = await prisma.product.findMany({
    where: {
      isActive: true,
      stock: { gt: 0 },
      orderItems: { none: { order: paidWhere } },
    },
    orderBy: { stock: "desc" },
    take: 8,
    select: { id: true, name: true, slug: true, stock: true },
  });

  const returnedUnits = returned.reduce((total, item) => total + item.quantity, 0);
  const damaged = returned
    .filter((item) => item.returnRequest.reason === "DAMAGED")
    .reduce((total, item) => total + item.quantity, 0);

  const refunds = await prisma.returnRequest.aggregate({
    where: { status: "COMPLETED", completedAt: { gte: from } },
    _sum: { refundAmount: true },
  });

  const onShelf = stockRows.reduce((total, product) => total + product.stock, 0);
  const valueAtCost = stockRows.reduce(
    (total, product) => total + (product.costPrice != null ? Number(product.costPrice) * product.stock : 0),
    0
  );

  return {
    days,
    from: from.toISOString(),
    money: {
      revenue: round2(revenue),
      orders,
      averageOrder: orders > 0 ? round2(revenue / orders) : 0,
      gstCollected: round2(num(totals._sum.taxTotal)),
      discountGiven: round2(num(totals._sum.discountTotal)),
      deliveryCharged: round2(num(totals._sum.shippingAmount)),
      refunded: round2(num(refunds._sum.refundAmount)),
    },
    margin: {
      netSales: round2(netSales),
      cost: round2(cost),
      profit: margin.profit,
      percent: margin.percent,
      coverage: unitsSold > 0 ? round2(costedUnits / unitsSold) : 0,
    },
    funnel: {
      bagsStarted: bags,
      checkoutsStarted: checkouts,
      paid: orders,
      abandonRate: checkouts > 0 ? round2(1 - orders / checkouts) : 0,
    },
    daily: daily.map((row) => ({
      day: new Date(row.day).toISOString().slice(0, 10),
      revenue: round2(num(row.revenue)),
      orders: Number(row.orders),
    })),
    topProducts: top.map((row) => ({
      id: row.productId,
      name: nameOf.get(row.productId)?.name ?? "Removed product",
      slug: nameOf.get(row.productId)?.slug ?? "",
      units: row._sum.quantity ?? 0,
      revenue: round2(num(row._sum.taxableAmount)),
    })),
    deadStock: dead,
    returns: {
      units: returnedUnits,
      rate: unitsSold > 0 ? round2(returnedUnits / unitsSold) : 0,
      damaged,
      wrongItem: returnedUnits - damaged,
    },
    stock: {
      onShelf,
      valueAtCost: round2(valueAtCost),
      lowCount: stockRows.filter((product) => product.stock <= product.lowStockThreshold).length,
    },
  };
}
