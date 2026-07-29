/**
 * Sanity check for the GST split. Run with:
 *   npx ts-node scripts/check-tax.ts
 *
 * There is no test runner in this repo yet, and money math is the last thing
 * that should go unchecked, so this asserts the properties that matter.
 */
process.env.SELLER_STATE = "Delhi";
process.env.GST_ENABLED = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "check-tax-only";

import { computeTax, round2 } from "../src/lib/tax";
import { allocateDiscount } from "../src/lib/coupon";
import { collapseLines } from "../src/lib/shipping";
import { freeDeliveryShortfall, shippingFee } from "../src/lib/shipping-policy";
import { photoRequired, refundBreakdown, returnEligibility } from "../src/lib/returns";
import { balanceFrom, isLowStock } from "../src/lib/inventory";
import { dailySeries, marginOf, shopDayOf, shopDayStart, windowDays } from "../src/lib/analytics";
import { recoveryPath, recoveryTokenMatches } from "../src/lib/cart-recovery";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

// A ₹1,299 item at 12%, buyer in the seller's own state.
const intra = computeTax({
  lines: [{ productId: "a", gross: 1299, rate: 12 }],
  shippingGross: 0,
  buyerState: "Delhi",
});

check("intra-state is detected", intra.intraState, true);
check("tax pulled out of 1299 @ 12%", intra.taxTotal, 139.18);
check("CGST is half", intra.cgstTotal, 69.59);
check("SGST is the other half", intra.sgstTotal, 69.59);
check("no IGST on a local sale", intra.igstTotal, 0);
check("taxable + tax equals the price", round2(intra.taxableTotal + intra.taxTotal), 1299);

// Same order going to another state.
const inter = computeTax({
  lines: [{ productId: "a", gross: 1299, rate: 12 }],
  shippingGross: 0,
  buyerState: "Karnataka",
});

check("inter-state is detected", inter.intraState, false);
check("IGST carries the whole tax", inter.igstTotal, 139.18);
check("no CGST on an interstate sale", inter.cgstTotal, 0);
check("the tax total is the same either way", inter.taxTotal, intra.taxTotal);

// Mixed rates plus shipping, which should follow the principal item's rate.
const mixed = computeTax({
  lines: [
    { productId: "a", gross: 2000, rate: 18 },
    { productId: "b", gross: 500, rate: 5 },
  ],
  shippingGross: 100,
  buyerState: "Delhi",
});

check("shipping is taxed at the principal rate", mixed.shippingTax, round2(100 - 100 / 1.18));
check(
  "nothing is lost or invented",
  round2(mixed.taxableTotal + mixed.taxTotal),
  2600
);
check("one bucket per rate", mixed.buckets.map((b) => b.rate), [5, 18]);

// A rate of zero must not produce tax or a divide-by-zero.
const exempt = computeTax({
  lines: [{ productId: "a", gross: 750, rate: 0 }],
  shippingGross: 0,
  buyerState: "Delhi",
});
check("a 0% item is untaxed", exempt.taxTotal, 0);
check("a 0% item is fully taxable value", exempt.taxableTotal, 750);

// No seller state means GST cannot be split, so it must switch itself off.
delete process.env.SELLER_STATE;
const off = computeTax({
  lines: [{ productId: "a", gross: 1299, rate: 12 }],
  shippingGross: 50,
  buyerState: "Delhi",
});
check("GST is off without a seller state", off.enabled, false);
check("nothing is taxed when it is off", off.taxTotal, 0);
check("the total still adds up when it is off", off.taxableTotal, 1349);
// The order rows are written from these lines, so a rate left on one would say
// tax was due and none was collected.
check("no rate is reported when it is off", off.lines[0].rate, 0);
check("the line is fully taxable value when it is off", off.lines[0].taxable, 1299);

// --- Discounts, and the way they drag GST down with them ---
process.env.SELLER_STATE = "Delhi";

const bag = [{ gross: 2000 }, { gross: 500 }, { gross: 300 }];

// A ₹400 discount over the whole bag.
const spread = allocateDiscount(bag, [0, 1, 2], 400);
check("the split adds up to the discount", round2(spread.reduce((a, b) => a + b, 0)), 400);
check("the biggest line takes the biggest share", spread[0] > spread[1] && spread[1] > spread[2], true);

// A targeted coupon must leave the lines it does not cover alone.
const targeted = allocateDiscount(bag, [1], 100);
check("an untargeted line is untouched", [targeted[0], targeted[2]], [0, 0]);
check("the targeted line takes all of it", targeted[1], 100);

// An awkward split that cannot divide cleanly still has to reconcile.
const awkward = allocateDiscount([{ gross: 100 }, { gross: 100 }, { gross: 100 }], [0, 1, 2], 100);
check("an indivisible split still sums exactly", round2(awkward.reduce((a, b) => a + b, 0)), 100);

// GST is owed on what is actually paid, so the discount has to come off first.
const undiscounted = computeTax({
  lines: [{ productId: "a", gross: 1000, rate: 18 }],
  shippingGross: 0,
  buyerState: "Delhi",
});
const discounted = computeTax({
  lines: [{ productId: "a", gross: 800, rate: 18 }],
  shippingGross: 0,
  buyerState: "Delhi",
});
check("a discount lowers the GST owed", discounted.taxTotal < undiscounted.taxTotal, true);
check("GST is charged on the discounted price", discounted.taxTotal, round2(800 - 800 / 1.18));

// Two rates, discount only on the 18% line: the 5% line's tax must not move.
const mixedDiscount = computeTax({
  lines: [
    { productId: "a", gross: 1600, rate: 18 },
    { productId: "b", gross: 500, rate: 5 },
  ],
  shippingGross: 0,
  buyerState: "Delhi",
});
check(
  "a targeted discount leaves the other rate's tax alone",
  mixedDiscount.lines[1].tax,
  round2(500 - 500 / 1.05)
);

// --- What the shop charges to deliver it ---

// The threshold is read against what the customer pays, so these are the two
// sides of it and the boundary itself.
process.env.SHIPPING_FREE_ABOVE = "299";
process.env.SHIPPING_FLAT_FEE = "49";

check("a big enough order ships free", shippingFee(300), 0);
check("the threshold itself ships free", shippingFee(299), 0);
check("a smaller order pays the flat fee", shippingFee(298), 49);
check("the fee is the same wherever it is going", shippingFee(100), shippingFee(298));
check("shortfall is what is left to the threshold", freeDeliveryShortfall(250), 49);
check("nothing is short once delivery is free", freeDeliveryShortfall(299), 0);

// No fee configured means delivery is simply free, and then there is no saving
// to dangle in front of anyone.
process.env.SHIPPING_FLAT_FEE = "0";
check("a small order still ships free when no fee is set", shippingFee(1), 0);
check("no shortfall to advertise when delivery is always free", freeDeliveryShortfall(1), 0);

// --- The bag itself, before any of the above sees it ---

// Stock is checked per line, so the same product twice has to become one line or
// 5 and 5 both pass against a stock of 8.
check(
  "a repeated product becomes one line",
  collapseLines([
    { productId: "a", quantity: 5 },
    { productId: "b", quantity: 1 },
    { productId: "a", quantity: 5 },
  ]),
  [
    { productId: "a", quantity: 10 },
    { productId: "b", quantity: 1 },
  ]
);
check(
  "a bag with nothing repeated is left as it is",
  collapseLines([
    { productId: "a", quantity: 2 },
    { productId: "b", quantity: 3 },
  ]),
  [
    { productId: "a", quantity: 2 },
    { productId: "b", quantity: 3 },
  ]
);

// --- What a return is worth ---

// A bag of three dresses at 500 with 300 off, so 1200 changed hands. The tax
// columns are what an order really stores: net of the discount, tax inside.
const discountedOrder = {
  itemsTotal: 1500,
  discountTotal: 300,
  shippingAmount: 0,
  items: [
    { id: "l1", price: 500, quantity: 1, taxableAmount: 357.14, taxAmount: 42.86 },
    { id: "l2", price: 500, quantity: 2, taxableAmount: 714.29, taxAmount: 85.71 },
  ],
};

check(
  "one discounted line is worth what was paid for it, not its sticker price",
  refundBreakdown(discountedOrder, [{ orderItemId: "l1", quantity: 1 }]).total,
  400
);
check(
  "half a line refunds half of what that line cost",
  refundBreakdown(discountedOrder, [{ orderItemId: "l2", quantity: 1 }]).total,
  400
);
check(
  "the whole bag back refunds exactly what was charged",
  refundBreakdown(discountedOrder, [
    { orderItemId: "l1", quantity: 1 },
    { orderItemId: "l2", quantity: 2 },
  ]).total,
  1200
);
check(
  "a line that is not on the order is worth nothing",
  refundBreakdown(discountedOrder, [{ orderItemId: "ghost", quantity: 1 }]).total,
  0
);
check(
  "asking for more units than were bought only refunds what was bought",
  refundBreakdown(discountedOrder, [{ orderItemId: "l1", quantity: 9 }]).total,
  400
);

// Delivery is only refunded when nothing is being kept.
const paidDelivery = {
  itemsTotal: 200,
  discountTotal: 0,
  shippingAmount: 49,
  items: [
    { id: "l1", price: 100, quantity: 1, taxableAmount: 100, taxAmount: 0 },
    { id: "l2", price: 100, quantity: 1, taxableAmount: 100, taxAmount: 0 },
  ],
};

check(
  "keeping something means keeping the delivery fee",
  refundBreakdown(paidDelivery, [{ orderItemId: "l1", quantity: 1 }]).shippingAmount,
  0
);
check(
  "sending everything back refunds the delivery too",
  refundBreakdown(paidDelivery, [
    { orderItemId: "l1", quantity: 1 },
    { orderItemId: "l2", quantity: 1 },
  ]).total,
  249
);

// Orders placed before the tax columns existed carry zeroes in them.
const legacyOrder = {
  itemsTotal: 1000,
  discountTotal: 100,
  shippingAmount: 0,
  items: [
    { id: "l1", price: 400, quantity: 1, taxableAmount: 0, taxAmount: 0 },
    { id: "l2", price: 600, quantity: 1, taxableAmount: 0, taxAmount: 0 },
  ],
};

check(
  "an order with no tax columns apportions the discount by value",
  refundBreakdown(legacyOrder, [{ orderItemId: "l1", quantity: 1 }]).total,
  360
);
check(
  "and still adds back up to what was charged",
  refundBreakdown(legacyOrder, [
    { orderItemId: "l1", quantity: 1 },
    { orderItemId: "l2", quantity: 1 },
  ]).total,
  900
);

// --- Who may ask for a return ---

const delivered = (over: Record<string, unknown> = {}) => ({
  status: "DELIVERED",
  paymentStatus: "PAID",
  deliveredAt: new Date(),
  items: [{ id: "l1", quantity: 2, price: 100, taxableAmount: 200, taxAmount: 0 }],
  returns: [],
  ...over,
});

check("a delivered paid order may be returned", returnEligibility(delivered()).open, true);
check(
  "an unpaid order may not",
  returnEligibility(delivered({ paymentStatus: "PENDING" })).block,
  "NOT_PAID"
);
check(
  "a parcel still in transit may not",
  returnEligibility(delivered({ status: "SHIPPED" })).block,
  "NOT_DELIVERED"
);
check(
  "an order delivered before we recorded dates goes to a human",
  returnEligibility(delivered({ deliveredAt: null })).block,
  "NO_DELIVERY_DATE"
);

process.env.RETURN_WINDOW_DAYS = "7";
const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
check(
  "the window closes after seven days",
  returnEligibility(delivered({ deliveredAt: eightDaysAgo })).block,
  "WINDOW_CLOSED"
);
const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
check(
  "six days after delivery is still in time",
  returnEligibility(delivered({ deliveredAt: sixDaysAgo })).open,
  true
);

check(
  "a return already being decided blocks a second one",
  returnEligibility(
    delivered({ returns: [{ status: "REQUESTED", items: [{ orderItemId: "l1", quantity: 1 }] }] })
  ).block,
  "ALREADY_OPEN"
);
check(
  "a settled return leaves the rest of the line claimable",
  returnEligibility(
    delivered({ returns: [{ status: "COMPLETED", items: [{ orderItemId: "l1", quantity: 1 }] }] })
  ).available,
  { l1: 1 }
);
check(
  "nothing is left once every unit has come back",
  returnEligibility(
    delivered({ returns: [{ status: "COMPLETED", items: [{ orderItemId: "l1", quantity: 2 }] }] })
  ).block,
  "NOTHING_LEFT"
);
check(
  "a refused return puts its units back within reach",
  returnEligibility(
    delivered({ returns: [{ status: "REJECTED", items: [{ orderItemId: "l1", quantity: 2 }] }] })
  ).available,
  { l1: 2 }
);

// A ₹1000 sale at 5% GST is ₹952.38 of sales and ₹47.62 of tax. Counting the tax
// as profit is the classic way a margin figure comes out flattering and wrong.
check("margin is worked out on sales net of GST", marginOf(952.38, 500).profit, 452.38);
check("and the percentage with it", marginOf(952.38, 500).percent, 47.5);
check("nothing sold is not a loss", marginOf(0, 0).percent, 0);
check(
  "a shop day starts at midnight in Delhi",
  shopDayStart(0, new Date("2026-07-29T02:00:00Z")).toISOString(),
  "2026-07-28T18:30:00.000Z"
);
check("an unknown window falls back to a month", windowDays("999"), 30);
check("a known one is kept", windowDays("7"), 7);

// Half past midnight in Delhi is still the evening before in London. An order
// taken then belongs to the day the shop was open, not to yesterday's takings.
check(
  "a late order counts on the day it was placed in Delhi",
  shopDayOf(new Date("2026-07-28T19:00:00Z")),
  "2026-07-29"
);
check(
  "and an order just before midnight IST is still today",
  shopDayOf(new Date("2026-07-28T18:29:00Z")),
  "2026-07-28"
);

const quiet = dailySeries(
  [{ at: new Date("2026-07-29T06:00:00Z"), amount: 500 }],
  3,
  new Date("2026-07-29T12:00:00Z")
);
check("a quiet day is a zero, not a missing bar", quiet.length, 3);
check("and the day with a sale carries it", quiet[2]?.revenue, 500);
check("while the others sit at nothing", quiet[0]?.revenue, 0);

// A recovery link is the only way into an order without signing in, so the
// signature on it has to be the thing that decides, not the order id.
const someOrder = "11111111-2222-3333-4444-555555555555";
const signed = recoveryPath(someOrder) ?? "";
check("a recovery link carries the order and a signature", /order=.+&token=[0-9a-f]{32}$/.test(signed), true);
check(
  "the signature it carries is accepted",
  recoveryTokenMatches(someOrder, signed.split("token=")[1] ?? ""),
  true
);
check("one letter out and it is refused", recoveryTokenMatches(someOrder, "0".repeat(32)), false);
check("an empty token is refused", recoveryTokenMatches(someOrder, ""), false);
check(
  "and a signature for one order does not open another",
  recoveryTokenMatches("66666666-7777-8888-9999-000000000000", signed.split("token=")[1] ?? ""),
  false
);

check("stock at the reorder level counts as low", isLowStock({ stock: 5, lowStockThreshold: 5 }), true);
check("one above it does not", isLowStock({ stock: 6, lowStockThreshold: 5 }), false);
check("a product with its own level uses it", isLowStock({ stock: 12, lowStockThreshold: 20 }), true);
check("an empty shelf is always low", isLowStock({ stock: 0 }), true);
check(
  "a ledger adds up to what the shelf should hold",
  balanceFrom([{ delta: 10 }, { delta: -3 }, { delta: 2 }, { delta: -1 }]),
  8
);

check("a damage claim has to come with a photo", photoRequired("DAMAGED"), true);
check("a wrong item does not need one", photoRequired("WRONG_ITEM"), false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
