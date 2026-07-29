import { prisma } from "./prisma";
import { lowStockProducts } from "./inventory";
import { sendLowStockDigest } from "./notifications";

const FLAG = "lowStockDigestSentOn";
const DEFAULT_HOUR = 9;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The shop's own day, not the server's.
 *
 * Render runs in UTC, so a digest keyed on the UTC date would land at half past
 * five in the morning in Delhi and read as yesterday's list to whoever opens it.
 */
function shopDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

function shopHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(now)
  );
}

function digestHour(): number {
  const raw = Number(process.env.LOW_STOCK_DIGEST_HOUR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.floor(raw) : DEFAULT_HOUR;
}

export type DigestOutcome = "sent" | "nothing-low" | "already-sent" | "too-early";

/**
 * Sends the restocking list, once a day.
 *
 * The day it last ran is written to the database rather than held in memory, so a
 * host that redeploys or wakes from sleep four times a day does not send four
 * emails. The day is marked even when nothing is low, since the point is one
 * attempt per day, not one email per day.
 */
export async function runLowStockDigest(options?: { force?: boolean }): Promise<DigestOutcome> {
  const now = new Date();
  const today = shopDay(now);

  if (!options?.force) {
    if (shopHour(now) < digestHour()) return "too-early";

    const flag = await prisma.systemFlag.findUnique({ where: { key: FLAG } });
    if (flag?.value === today) return "already-sent";
  }

  const products = await lowStockProducts();

  await prisma.systemFlag.upsert({
    where: { key: FLAG },
    create: { key: FLAG, value: today },
    update: { value: today },
  });

  if (products.length === 0) return "nothing-low";

  await sendLowStockDigest(products);
  console.log(`Low stock digest sent for ${products.length} product(s)`);
  return "sent";
}

/**
 * Checks hourly and lets the date decide, rather than firing every 24 hours from
 * whenever the process happened to start. Also runs on the way up, because a host
 * that sleeps between requests never sits still long enough to reach an interval.
 */
export function startLowStockDigest(): void {
  const run = () => {
    runLowStockDigest().catch((error) => console.error("Low stock digest failed:", error));
  };

  run();
  setInterval(run, CHECK_INTERVAL_MS).unref();
}
