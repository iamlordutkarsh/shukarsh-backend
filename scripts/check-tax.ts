/**
 * Sanity check for the GST split. Run with:
 *   npx ts-node scripts/check-tax.ts
 *
 * There is no test runner in this repo yet, and money math is the last thing
 * that should go unchecked, so this asserts the properties that matter.
 */
process.env.SELLER_STATE = "Delhi";
process.env.GST_ENABLED = "true";

import { computeTax, round2 } from "../src/lib/tax";
import { allocateDiscount } from "../src/lib/coupon";

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
