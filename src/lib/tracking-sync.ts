import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { nextOrderStatus } from "./order-status";
import { isShiprocketConfigured, orderStatusFromCode, trackByAwb } from "./shiprocket";

export interface SyncResult {
  checked: number;
  advanced: number;
  failed: number;
}

/**
 * Pulls the latest courier scans for everything still in flight and moves the
 * order forward when the courier says so.
 *
 * The Shiprocket webhook already pushes these updates, but a webhook that is
 * misconfigured, rate limited or simply dropped leaves an order sitting on
 * Processing forever. Polling is the safety net, so parcels do not need a human
 * watching them.
 */
export async function syncActiveShipments(limit = 40): Promise<SyncResult> {
  const result: SyncResult = { checked: 0, advanced: 0, failed: 0 };
  if (!isShiprocketConfigured()) return result;

  const shipments = await prisma.shipment.findMany({
    where: {
      awb: { not: null },
      provider: { not: "manual" },
      order: { status: { in: ["PROCESSING", "SHIPPED"] } },
    },
    include: { order: { select: { id: true, status: true } } },
    // Longest untouched first, and never synced counts as longest.
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });

  for (const shipment of shipments) {
    result.checked += 1;

    try {
      const tracking = await trackByAwb(shipment.awb!);

      await prisma.shipment.update({
        where: { id: shipment.id },
        data: {
          status: tracking.currentStatus ?? shipment.status,
          statusCode: tracking.statusCode,
          events: tracking.events as unknown as Prisma.InputJsonValue,
          trackingUrl: tracking.trackUrl ?? shipment.trackingUrl,
          lastSyncedAt: new Date(),
        },
      });

      const next = nextOrderStatus(shipment.order.status, orderStatusFromCode(tracking.statusCode));
      if (next) {
        await prisma.order.update({ where: { id: shipment.orderId }, data: { status: next as never } });
        result.advanced += 1;
        console.log(`Tracking sync moved order ${shipment.orderId} to ${next}`);
      }
    } catch (error) {
      result.failed += 1;
      // One bad AWB must not stop the rest of the batch.
      console.error(`Tracking sync failed for AWB ${shipment.awb}:`, error);
      await prisma.shipment
        .update({ where: { id: shipment.id }, data: { lastSyncedAt: new Date() } })
        .catch(() => {});
    }
  }

  return result;
}

const MIN_GAP_MS = (Number(process.env.TRACKING_SYNC_MIN_GAP_SEC) || 300) * 1000;
let lastRunAt = 0;
let lastResult: SyncResult = { checked: 0, advanced: 0, failed: 0 };
let inFlight: Promise<SyncResult> | null = null;

export interface ThrottledSync extends SyncResult {
  /** True when this call reused a recent run instead of asking the courier again. */
  skipped: boolean;
}

/**
 * Sync guarded by a cooldown, for anything a person can trigger repeatedly.
 *
 * The admin panel runs this every time it opens, so without a gap a few page
 * refreshes would mean a courier lookup per parcel each time. Concurrent calls
 * share one run rather than stacking up.
 */
export async function syncActiveShipmentsThrottled(): Promise<ThrottledSync> {
  const since = Date.now() - lastRunAt;
  if (since < MIN_GAP_MS) return { ...lastResult, skipped: true };
  if (inFlight) return { ...(await inFlight), skipped: false };

  inFlight = syncActiveShipments();

  try {
    lastResult = await inFlight;
    lastRunAt = Date.now();
    return { ...lastResult, skipped: false };
  } finally {
    inFlight = null;
  }
}

/**
 * Optional in-process poller. Off unless an interval is configured, since a
 * host that sleeps between requests cannot be relied on to run it.
 */
export function startTrackingSync(): void {
  const minutes = Number(process.env.TRACKING_SYNC_INTERVAL_MIN);
  if (!minutes || minutes <= 0) return;

  const run = () => {
    syncActiveShipments()
      .then(({ checked, advanced }) => {
        if (checked > 0) console.log(`Tracking sync checked ${checked} shipments, advanced ${advanced}`);
      })
      .catch((error) => console.error("Tracking sync run failed:", error));
  };

  setInterval(run, minutes * 60 * 1000).unref();
  console.log(`Tracking sync scheduled every ${minutes} minutes`);
}
