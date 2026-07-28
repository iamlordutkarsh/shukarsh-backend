/**
 * What does it actually cost to send a parcel across India? Run with:
 *   npx ts-node scripts/shipping-rates.ts
 *   npx ts-node scripts/shipping-rates.ts --weights=0.5,1,2 --value=499
 *
 * A free-delivery threshold and a flat fee are both bets on the shape of this
 * distribution, and guessing them is how a store ends up paying to ship. This
 * asks Shiprocket for real rates to a spread of pincodes and prints the median
 * and p90 you should be setting those two numbers from.
 *
 * Read only: serviceability quotes, no orders, no labels.
 */
import "dotenv/config";

import { getServiceability, isShiprocketConfigured, pickupPincode } from "../src/lib/shiprocket";

interface Destination {
  pincode: string;
  city: string;
  zone: string;
}

/**
 * Spread rather than a sample: a store's shipping bill is decided by the tail,
 * so the north east, Kashmir and the islands have to be in here even though
 * they are a rounding error in order count.
 */
const DESTINATIONS: Destination[] = [
  { pincode: "226001", city: "Lucknow", zone: "Same state" },
  { pincode: "208001", city: "Kanpur", zone: "Same state" },
  { pincode: "221001", city: "Varanasi", zone: "Same state" },
  { pincode: "201301", city: "Noida", zone: "Same state" },
  { pincode: "110001", city: "New Delhi", zone: "North" },
  { pincode: "160017", city: "Chandigarh", zone: "North" },
  { pincode: "302001", city: "Jaipur", zone: "North" },
  { pincode: "248001", city: "Dehradun", zone: "North" },
  { pincode: "400001", city: "Mumbai", zone: "West" },
  { pincode: "411001", city: "Pune", zone: "West" },
  { pincode: "380001", city: "Ahmedabad", zone: "West" },
  { pincode: "395003", city: "Surat", zone: "West" },
  { pincode: "403001", city: "Panaji", zone: "West" },
  { pincode: "452001", city: "Indore", zone: "Central" },
  { pincode: "462001", city: "Bhopal", zone: "Central" },
  { pincode: "440001", city: "Nagpur", zone: "Central" },
  { pincode: "492001", city: "Raipur", zone: "Central" },
  { pincode: "560001", city: "Bengaluru", zone: "South" },
  { pincode: "600001", city: "Chennai", zone: "South" },
  { pincode: "500001", city: "Hyderabad", zone: "South" },
  { pincode: "682001", city: "Kochi", zone: "South" },
  { pincode: "641001", city: "Coimbatore", zone: "South" },
  { pincode: "530001", city: "Visakhapatnam", zone: "South" },
  { pincode: "700001", city: "Kolkata", zone: "East" },
  { pincode: "751001", city: "Bhubaneswar", zone: "East" },
  { pincode: "800001", city: "Patna", zone: "East" },
  { pincode: "834001", city: "Ranchi", zone: "East" },
  { pincode: "781001", city: "Guwahati", zone: "Remote" },
  { pincode: "793001", city: "Shillong", zone: "Remote" },
  { pincode: "795001", city: "Imphal", zone: "Remote" },
  { pincode: "190001", city: "Srinagar", zone: "Remote" },
  { pincode: "194101", city: "Leh", zone: "Remote" },
  { pincode: "744101", city: "Port Blair", zone: "Remote" },
];

interface Args {
  weights: number[];
  value: number;
  delayMs: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

  const weights = (get("weights") ?? "0.5,1,2")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value > 0);

  return {
    weights: weights.length ? weights : [0.5, 1, 2],
    value: Number(get("value")) || 499,
    delayMs: Number(get("delay")) || 350,
    limit: Number(get("limit")) || DESTINATIONS.length,
  };
}

/** Nearest rank, which is the honest reading of 33 samples. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rupees(amount: number): string {
  return `₹${amount.toFixed(0)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sample {
  destination: Destination;
  cheapest: number | null;
  cheapestCourier: string | null;
  chosen: number | null;
  etdDays: number | null;
  note: string | null;
}

/**
 * `chosen` mirrors resolveShipping: the recommended courier if Shiprocket names
 * one, otherwise the cheapest. That is the rate the store is actually billed,
 * so it is the one the flat fee has to cover.
 */
async function survey(weightKg: number, declaredValue: number, args: Args): Promise<Sample[]> {
  const samples: Sample[] = [];
  const dimension = weightKg <= 0.5 ? 15 : weightKg <= 1 ? 20 : 28;

  for (const destination of DESTINATIONS.slice(0, args.limit)) {
    try {
      const { options, blocked } = await getServiceability({
        deliveryPincode: destination.pincode,
        weightKg,
        declaredValue,
        lengthCm: dimension,
        breadthCm: Math.round(dimension * 0.8),
        heightCm: Math.round(dimension * 0.4),
      });

      if (options.length === 0) {
        samples.push({
          destination,
          cheapest: null,
          cheapestCourier: null,
          chosen: null,
          etdDays: null,
          note: blocked.length ? `not serviceable (${blocked[0].reason})` : "not serviceable",
        });
      } else {
        const cheapest = options[0];
        const chosen = options.find((option) => option.recommended) ?? cheapest;
        samples.push({
          destination,
          cheapest: Math.round(cheapest.rate),
          cheapestCourier: cheapest.courierName,
          chosen: Math.round(chosen.rate),
          etdDays: chosen.etdDays ?? cheapest.etdDays,
          note: null,
        });
      }
    } catch (error) {
      samples.push({
        destination,
        cheapest: null,
        cheapestCourier: null,
        chosen: null,
        etdDays: null,
        note: error instanceof Error ? error.message : "quote failed",
      });
    }

    await sleep(args.delayMs);
  }

  return samples;
}

interface Stats {
  min: number;
  median: number;
  p90: number;
  max: number;
}

function statsOf(rates: number[]): Stats {
  const sorted = [...rates].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function report(weightKg: number, samples: Sample[]): { cheapest: Stats; billed: Stats; count: number } {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${weightKg} kg parcel from ${pickupPincode()}`);
  console.log("=".repeat(72));
  console.log(`${pad("Destination", 16)}${pad("Zone", 12)}${padLeft("Cheapest", 9)}${padLeft("Billed", 8)}  ${pad("ETD", 6)}Courier`);
  console.log("-".repeat(72));

  for (const sample of samples) {
    const label = `${sample.destination.city} ${sample.destination.pincode}`;
    if (sample.chosen == null) {
      console.log(`${pad(label, 16)}${pad(sample.destination.zone, 12)}${padLeft("-", 9)}${padLeft("-", 8)}  ${sample.note}`);
      continue;
    }
    console.log(
      `${pad(label, 16)}${pad(sample.destination.zone, 12)}${padLeft(rupees(sample.cheapest ?? 0), 9)}` +
        `${padLeft(rupees(sample.chosen), 8)}  ${pad(sample.etdDays ? `${sample.etdDays}d` : "-", 6)}${sample.cheapestCourier ?? ""}`
    );
  }

  const billedRates = samples.map((sample) => sample.chosen).filter((rate): rate is number => rate != null);
  const cheapestRates = samples.map((sample) => sample.cheapest).filter((rate): rate is number => rate != null);
  const billed = statsOf(billedRates);
  const cheapest = statsOf(cheapestRates);

  const unserviceable = samples.length - billedRates.length;
  console.log("-".repeat(72));
  const line = (label: string, stats: Stats) =>
    `${pad(label, 10)}min ${padLeft(rupees(stats.min), 5)}   median ${padLeft(rupees(stats.median), 5)}   ` +
    `p90 ${padLeft(rupees(stats.p90), 5)}   max ${padLeft(rupees(stats.max), 5)}`;
  console.log(line("cheapest", cheapest));
  console.log(line("billed", billed));
  console.log(
    `n=${billedRates.length}${unserviceable ? `  (${unserviceable} unserviceable)` : ""}  ` +
      `picking cheapest instead of recommended saves ${rupees(billed.median - cheapest.median)} on the median parcel`
  );

  const byZone = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.chosen == null) continue;
    const list = byZone.get(sample.destination.zone) ?? [];
    list.push(sample.chosen);
    byZone.set(sample.destination.zone, list);
  }
  const zones = [...byZone]
    .map(([zone, rates]) => `${zone} ${rupees(rates.reduce((a, b) => a + b, 0) / rates.length)}`)
    .join("   ");
  console.log(`average billed by zone: ${zones}`);

  return { cheapest, billed, count: billedRates.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isShiprocketConfigured() || !pickupPincode()) {
    console.error("Shiprocket is not configured. This needs live credentials to quote real rates.\n");
    console.error("Set these in .env (gitignored) and run again:");
    for (const key of [
      "SHIPROCKET_EMAIL",
      "SHIPROCKET_PASSWORD",
      "SHIPROCKET_PICKUP_LOCATION",
      "SHIPROCKET_PICKUP_PINCODE",
    ]) {
      console.error(`  ${key}${process.env[key] ? " (set)" : ""}`);
    }
    process.exit(1);
  }

  console.log(
    `Quoting ${Math.min(args.limit, DESTINATIONS.length)} destinations × ${args.weights.length} weights ` +
      `at a declared value of ${rupees(args.value)}. Billed = what resolveShipping would pick.`
  );

  const summary: { weightKg: number; cheapest: Stats; billed: Stats }[] = [];

  for (const weightKg of args.weights) {
    const samples = await survey(weightKg, args.value, args);
    const { cheapest, billed } = report(weightKg, samples);
    summary.push({ weightKg, cheapest, billed });
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("Setting the two numbers");
  console.log("=".repeat(72));

  for (const row of summary) {
    console.log(
      `${row.weightKg} kg, booking the cheapest courier:  a flat fee of ${rupees(row.cheapest.median)} ` +
        `breaks even on the median order, ${rupees(row.cheapest.p90)} covers 9 in 10, ` +
        `worst case ${rupees(row.cheapest.max)}`
    );
  }

  const taxable = args.value / 1.05;
  console.log(`\nFree delivery over ${rupees(args.value)}, absorbing the cheapest courier:`);
  for (const row of summary) {
    console.log(
      `  ${row.weightKg} kg costs ${rupees(row.cheapest.median)} typically and ${rupees(row.cheapest.p90)} ` +
        `on 9 in 10. Needs a cost of goods under ${rupees(taxable - row.cheapest.p90)} of the ` +
        `${rupees(taxable)} taxable to still make money.`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
