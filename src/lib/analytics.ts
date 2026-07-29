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

/** Which shop day an instant belongs to, as YYYY-MM-DD. */
export function shopDayOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Takings per day, including the days nothing sold on.
 *
 * A day with no orders has to appear as a zero rather than go missing, or the
 * chart closes the gap and a quiet week reads as a steady one. Bucketed here in
 * plain TypeScript rather than by the database so the boundary between one shop
 * day and the next is something that can be tested.
 */
export function dailySeries(
  orders: { at: Date; amount: number }[],
  days: number,
  now = new Date()
): { day: string; revenue: number; orders: number }[] {
  const buckets = new Map<string, { day: string; revenue: number; orders: number }>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = shopDayOf(shopDayStart(back, now));
    buckets.set(day, { day, revenue: 0, orders: 0 });
  }

  for (const order of orders) {
    const bucket = buckets.get(shopDayOf(order.at));
    if (!bucket) continue;
    bucket.revenue += order.amount;
    bucket.orders += 1;
  }

  return [...buckets.values()].map((bucket) => ({ ...bucket, revenue: round2(bucket.revenue) }));
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
  /**
   * Only from checkout onwards. The bag lives in the customer's own browser and
   * is never sent to us until they check out, so anything earlier than this is
   * not ours to count.
   */
  funnel: {
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

/** Every number the dashboard shows, in one pass. */
export async function analyticsSummary(days: number): Promise<AnalyticsSummary> {
  const from = shopDayStart(days - 1);
  const paidWhere = paidIn(from);

  // One connection, not ten.
  //
  // Fanning these out with Promise.all asks the pooler for a client per query, and
  // the whole shop only gets fifteen. A page nobody but the owner looks at must not
  // be able to take the checkout down with it. Running them as one batch also means
  // every figure describes the same instant rather than a smear across the read.
  const [paidOrders, items, costRows, checkouts, top, returned, stockRows, dead, refunds] =
    await prisma.$transaction([
      // The money columns and the dates come back together so the headline figure
      // and the chart are added up from the same rows. Two queries would be two
      // chances for the total on the card to disagree with the bars under it.
      prisma.order.findMany({
        where: paidWhere,
        select: {
          paidAt: true,
          createdAt: true,
          totalAmount: true,
          taxTotal: true,
          discountTotal: true,
          shippingAmount: true,
        },
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

      prisma.order.count({ where: { createdAt: { gte: from } } }),

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

      // Anything on the shelf that has not sold once in the window. The point is
      // what to stop reordering, so switched-off products and empty shelves are
      // not it.
      prisma.product.findMany({
        where: {
          isActive: true,
          stock: { gt: 0 },
          orderItems: { none: { order: paidWhere } },
        },
        orderBy: { stock: "desc" },
        take: 8,
        select: { id: true, name: true, slug: true, stock: true },
      }),

      prisma.returnRequest.aggregate({
        where: { status: "COMPLETED", completedAt: { gte: from } },
        _sum: { refundAmount: true },
      }),
    ]);

  let revenue = 0;
  let gst = 0;
  let discount = 0;
  let delivery = 0;
  for (const order of paidOrders) {
    revenue += num(order.totalAmount);
    gst += num(order.taxTotal);
    discount += num(order.discountTotal);
    delivery += num(order.shippingAmount);
  }
  const orders = paidOrders.length;

  const daily = dailySeries(
    paidOrders.map((order) => ({
      at: order.paidAt ?? order.createdAt,
      amount: num(order.totalAmount),
    })),
    days
  );

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

  const returnedUnits = returned.reduce((total, item) => total + item.quantity, 0);
  const damaged = returned
    .filter((item) => item.returnRequest.reason === "DAMAGED")
    .reduce((total, item) => total + item.quantity, 0);

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
      gstCollected: round2(gst),
      discountGiven: round2(discount),
      deliveryCharged: round2(delivery),
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
      checkoutsStarted: checkouts,
      paid: orders,
      abandonRate: checkouts > 0 ? round2(1 - orders / checkouts) : 0,
    },
    daily,
    topProducts: top.map((row) => ({
      id: row.productId,
      name: nameOf.get(row.productId)?.name ?? "Removed product",
      slug: nameOf.get(row.productId)?.slug ?? "",
      units: row._sum?.quantity ?? 0,
      revenue: round2(num(row._sum?.taxableAmount)),
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
