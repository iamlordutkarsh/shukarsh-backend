import { Router } from "express";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyToken } from "../lib/auth";
import { authenticate, requireAdmin } from "../middleware/auth";
import { pincodeSchema, splitName } from "../lib/address";
import { serializeOrder } from "../lib/order";
import { sendDispatchNotice } from "../lib/notifications";
import { nextOrderStatus } from "../lib/order-status";
import { syncActiveShipments } from "../lib/tracking-sync";
import { priceCart, quoteShipping } from "../lib/shipping";
import { createTtlCache } from "../lib/parcel";
import {
  ShiprocketError,
  assignAwb,
  cancelShipmentByAwb,
  createAdhocOrder,
  generateInvoice,
  generateLabel,
  generateManifest,
  getPincodeDetails,
  isShiprocketConfigured,
  listPickupLocations,
  normalizeEvents,
  orderStatusFromCode,
  pickupPincode,
  requestPickup,
  trackByAwb,
  type TrackingEvent,
} from "../lib/shiprocket";

const router = Router();

const pincodeCache = createTtlCache<{ city: string | null; state: string | null }>(24 * 60 * 60);

const ratesSchema = z.object({
  pincode: pincodeSchema,
  items: z
    .array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().max(20) }))
    .min(1),
});

/** Prisma's Json input type does not accept a bare array of interfaces. */
function asJson(events: TrackingEvent[]): Prisma.InputJsonValue {
  return events as unknown as Prisma.InputJsonValue;
}

const shipSchema = z.object({ courierId: z.number().int().positive().optional() });

const manualTrackingSchema = z.object({
  awb: z.string().trim().min(3).max(40),
  courierName: z.string().trim().max(60).optional(),
  trackingUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
});
const pickupSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

function handleProviderError(res: any, error: unknown, fallback: string) {
  if (error instanceof ShiprocketError) {
    console.error("Shiprocket error:", error.status, error.message, JSON.stringify(error.payload));
    res.status(error.status === 503 ? 503 : 502).json({ error: error.message });
    return;
  }

  console.error(fallback, error);
  res.status(500).json({ error: fallback });
}

router.get("/config", (_req, res) => {
  res.json({
    enabled: isShiprocketConfigured() && Boolean(pickupPincode()),
    pickupPincode: pickupPincode() || null,
  });
});

router.post("/rates", async (req, res) => {
  const result = ratesSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "A valid pincode and cart are required" });
    return;
  }

  if (!isShiprocketConfigured() || !pickupPincode()) {
    res.json({ enabled: false, serviceable: true, options: [], freeShipping: true });
    return;
  }

  try {
    const cart = await priceCart(result.data.items);
    const quote = await quoteShipping({
      pincode: result.data.pincode,
      parcel: cart.parcel,
      declaredValue: cart.itemsTotal,
    });

    res.json({
      enabled: true,
      serviceable: quote.serviceable,
      weightKg: cart.parcel.weightKg,
      options: quote.options.slice(0, 4),
      blocked: quote.blocked.slice(0, 3),
      freeShipping: false,
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      res.status(statusCode).json({ error: (error as Error).message });
      return;
    }

    handleProviderError(res, error, "Could not fetch shipping rates");
  }
});

router.get("/pincode/:pincode", async (req, res) => {
  const parsed = pincodeSchema.safeParse(req.params.pincode);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid 6 digit pincode" });
    return;
  }

  const pincode = parsed.data;
  const cached = pincodeCache.get(pincode);
  if (cached) {
    res.json(cached);
    return;
  }

  if (!isShiprocketConfigured()) {
    res.json({ city: null, state: null });
    return;
  }

  try {
    const details = await getPincodeDetails(pincode);
    const payload = { city: details.city, state: details.state };
    pincodeCache.set(pincode, payload);
    res.json(payload);
  } catch (error) {
    console.error("Pincode lookup failed:", error);
    res.json({ city: null, state: null });
  }
});

function cronKeyMatches(provided: string | undefined): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || !provided || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Refreshes every in flight shipment and advances the orders the courier has
 * moved on. Open to an admin from the dashboard, or to a scheduler holding the
 * cron secret.
 */
router.post("/sync", async (req, res) => {
  const byCron = cronKeyMatches(req.headers["x-cron-key"] as string | undefined);

  if (!byCron) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      if (verifyToken(header.slice(7)).role !== "ADMIN") {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    res.json(await syncActiveShipments());
  } catch (error) {
    handleProviderError(res, error, "Could not refresh tracking");
  }
});

router.get("/pickup-locations", authenticate, requireAdmin, async (_req, res) => {
  try {
    res.json({ locations: await listPickupLocations() });
  } catch (error) {
    handleProviderError(res, error, "Could not load pickup locations");
  }
});

async function loadOrderForShipping(id: string) {
  return prisma.order.findUnique({
    where: { id },
    include: {
      shipment: true,
      items: { include: { product: { select: { id: true, name: true, slug: true, hsn: true } } } },
    },
  });
}

router.get("/orders/:id/rates", authenticate, requireAdmin, async (req, res) => {
  const order = await loadOrderForShipping(req.params.id as string);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  try {
    const cart = await priceCart(order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })));
    const address = order.shippingAddress as { zip?: string } | null;
    if (!address?.zip) {
      res.status(400).json({ error: "This order has no delivery pincode" });
      return;
    }

    const quote = await quoteShipping({
      pincode: address.zip,
      parcel: cart.parcel,
      declaredValue: Number(order.itemsTotal || order.totalAmount),
    });

    res.json({ serviceable: quote.serviceable, options: quote.options, weightKg: cart.parcel.weightKg });
  } catch (error) {
    handleProviderError(res, error, "Could not fetch courier options");
  }
});

router.post("/orders/:id/ship", authenticate, requireAdmin, async (req, res) => {
  const parsed = shipSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid courier" });
    return;
  }

  const id = req.params.id as string;
  const order = await loadOrderForShipping(id);

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (order.paymentStatus !== "PAID") {
    res.status(409).json({ error: "This order has not been paid for yet" });
    return;
  }

  const address = order.shippingAddress as Record<string, string> | null;
  if (!address?.zip || !address?.line1 || !address?.city || !address?.state) {
    res.status(400).json({ error: "This order is missing a complete delivery address" });
    return;
  }

  const phone = order.customerPhone ?? address.phone;
  const name = order.customerName ?? address.name;
  if (!phone || !name) {
    res.status(400).json({ error: "This order has no recipient name or phone number" });
    return;
  }

  try {
    const cart = await priceCart(order.items.map((item) => ({ productId: item.productId, quantity: item.quantity })));
    let shipment = order.shipment;

    if (!shipment?.providerShipmentId) {
      const { first, last } = splitName(name);
      const reference = shipment?.providerReference ?? `SHK-${order.id.slice(0, 8).toUpperCase()}`;

      const created = await createAdhocOrder({
        reference,
        orderDate: new Date(order.createdAt).toISOString().slice(0, 16).replace("T", " "),
        customerName: first,
        lastName: last,
        address: address.line1,
        address2: address.line2,
        city: address.city,
        state: address.state,
        pincode: address.zip,
        country: address.country || "India",
        email: order.email ?? "orders@shukarsh.com",
        phone,
        items: order.items.map((item) => ({
          name: item.product.name,
          sku: item.product.slug,
          units: item.quantity,
          sellingPrice: Number(item.price),
          hsn: item.product.hsn ?? undefined,
        })),
        subTotal: Number(order.itemsTotal || order.totalAmount),
        shippingCharges: Number(order.shippingAmount ?? 0),
        weightKg: cart.parcel.weightKg,
        lengthCm: cart.parcel.lengthCm,
        breadthCm: cart.parcel.breadthCm,
        heightCm: cart.parcel.heightCm,
      });

      shipment = await prisma.shipment.upsert({
        where: { orderId: order.id },
        update: {
          providerOrderId: created.providerOrderId,
          providerShipmentId: created.providerShipmentId,
          providerReference: reference,
          status: created.status,
          statusCode: created.statusCode,
        },
        create: {
          orderId: order.id,
          providerOrderId: created.providerOrderId,
          providerShipmentId: created.providerShipmentId,
          providerReference: reference,
          status: created.status,
          statusCode: created.statusCode,
        },
      });
    }

    if (!shipment.awb) {
      const awb = await assignAwb(shipment.providerShipmentId!, parsed.data.courierId ?? order.courierId ?? undefined);

      shipment = await prisma.shipment.update({
        where: { orderId: order.id },
        data: {
          awb: awb.awb,
          courierId: awb.courierId,
          courierName: awb.courierName,
          appliedWeightKg: awb.appliedWeightKg ?? undefined,
          pickupScheduledAt: awb.pickupScheduledAt ? new Date(awb.pickupScheduledAt) : undefined,
          trackingUrl: `https://shiprocket.co/tracking/${awb.awb}`,
        },
      });
    }

    if (!shipment.labelUrl) {
      const labelUrl = await generateLabel(shipment.providerShipmentId!);
      shipment = await prisma.shipment.update({ where: { orderId: order.id }, data: { labelUrl } });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: order.status === "PENDING" || order.status === "PROCESSING" ? "SHIPPED" : order.status,
        courierId: shipment.courierId ?? order.courierId,
        courierName: shipment.courierName ?? order.courierName,
      },
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
        shipment: true,
        items: { include: { product: { select: { id: true, name: true, slug: true, images: true } } } },
      },
    });

    if (shipment.awb) void sendDispatchNotice(order.id);

    res.json({ order: serializeOrder(updated) });
  } catch (error) {
    handleProviderError(res, error, "Could not create this shipment");
  }
});

/**
 * Records a tracking number the store got outside Shiprocket, so a parcel sent
 * by India Post or handed to a local courier still shows the customer where it
 * is. Marks the order shipped, since an AWB means it has left.
 */
router.patch("/orders/:id/tracking", authenticate, requireAdmin, async (req, res) => {
  const parsed = manualTrackingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Enter a valid tracking number" });
    return;
  }

  const id = req.params.id as string;
  const order = await prisma.order.findUnique({ where: { id }, include: { shipment: true } });

  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (order.shipment?.providerShipmentId) {
    res.status(409).json({
      error: "This order already has a Shiprocket shipment. Cancel it before entering tracking by hand.",
    });
    return;
  }

  const { awb, courierName, trackingUrl } = parsed.data;
  const details = {
    provider: "manual",
    awb,
    courierName: courierName || null,
    trackingUrl: trackingUrl || null,
    status: "SHIPPED",
  };

  try {
    await prisma.shipment.upsert({
      where: { orderId: id },
      update: details,
      create: { orderId: id, ...details },
    });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: order.status === "PENDING" || order.status === "PROCESSING" ? "SHIPPED" : order.status,
        courierName: courierName || order.courierName,
      },
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
        shipment: true,
        items: { include: { product: { select: { id: true, name: true, slug: true, images: true } } } },
      },
    });

    void sendDispatchNotice(id);

    res.json({ order: serializeOrder(updated) });
  } catch (error) {
    console.error("Manual tracking update failed:", error);
    res.status(500).json({ error: "Could not save this tracking number" });
  }
});

router.post("/orders/:id/pickup", authenticate, requireAdmin, async (req, res) => {
  const parsed = pickupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pickup date" });
    return;
  }

  const shipment = await prisma.shipment.findUnique({ where: { orderId: req.params.id as string } });
  if (!shipment?.providerShipmentId) {
    res.status(404).json({ error: "Create the shipment first" });
    return;
  }

  try {
    const pickup = await requestPickup(shipment.providerShipmentId, parsed.data.date);
    const saved = await prisma.shipment.update({
      where: { orderId: shipment.orderId },
      data: {
        pickupScheduledAt: pickup.scheduledAt ? new Date(pickup.scheduledAt) : undefined,
        pickupToken: pickup.token,
      },
    });

    res.json({ shipment: saved });
  } catch (error) {
    handleProviderError(res, error, "Could not schedule a pickup");
  }
});

router.post("/orders/:id/invoice", authenticate, requireAdmin, async (req, res) => {
  const shipment = await prisma.shipment.findUnique({ where: { orderId: req.params.id as string } });
  if (!shipment?.providerOrderId) {
    res.status(404).json({ error: "Create the shipment first" });
    return;
  }

  try {
    const invoiceUrl = await generateInvoice(shipment.providerOrderId);
    const saved = await prisma.shipment.update({ where: { orderId: shipment.orderId }, data: { invoiceUrl } });
    res.json({ shipment: saved });
  } catch (error) {
    handleProviderError(res, error, "Could not generate an invoice");
  }
});

router.post("/orders/:id/manifest", authenticate, requireAdmin, async (req, res) => {
  const shipment = await prisma.shipment.findUnique({ where: { orderId: req.params.id as string } });
  if (!shipment?.providerShipmentId) {
    res.status(404).json({ error: "Create the shipment first" });
    return;
  }

  try {
    const manifestUrl = await generateManifest(shipment.providerShipmentId);
    const saved = await prisma.shipment.update({ where: { orderId: shipment.orderId }, data: { manifestUrl } });
    res.json({ shipment: saved });
  } catch (error) {
    handleProviderError(res, error, "Could not generate a manifest");
  }
});

router.post("/orders/:id/cancel-shipment", authenticate, requireAdmin, async (req, res) => {
  const shipment = await prisma.shipment.findUnique({ where: { orderId: req.params.id as string } });
  if (!shipment?.awb) {
    res.status(404).json({ error: "This order has no AWB to cancel" });
    return;
  }

  try {
    await cancelShipmentByAwb(shipment.awb);
    const saved = await prisma.shipment.update({
      where: { orderId: shipment.orderId },
      data: { status: "CANCELLATION REQUESTED" },
    });
    res.json({ shipment: saved });
  } catch (error) {
    handleProviderError(res, error, "Could not cancel this shipment");
  }
});

router.get("/orders/:id/track", authenticate, async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id as string },
    include: { shipment: true },
  });

  if (!order || (req.user!.role !== "ADMIN" && order.userId !== req.user!.id)) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (!order.shipment?.awb) {
    res.json({ tracking: null });
    return;
  }

  // A hand entered AWB belongs to a courier Shiprocket never saw, so there is
  // nothing to poll. Hand back what we were told instead of erroring.
  if (order.shipment.provider === "manual") {
    res.json({
      tracking: {
        awb: order.shipment.awb,
        courierName: order.shipment.courierName,
        currentStatus: order.shipment.status,
        statusCode: null,
        trackUrl: order.shipment.trackingUrl,
        etd: null,
        deliveredAt: null,
        events: [],
      },
    });
    return;
  }

  try {
    const tracking = await trackByAwb(order.shipment.awb);
    await prisma.shipment.update({
      where: { orderId: order.id },
      data: {
        status: tracking.currentStatus,
        statusCode: tracking.statusCode,
        events: asJson(tracking.events),
        trackingUrl: tracking.trackUrl ?? order.shipment.trackingUrl,
        lastSyncedAt: new Date(),
      },
    });

    res.json({ tracking });
  } catch (error) {
    handleProviderError(res, error, "Could not fetch tracking right now");
  }
});

function tokenMatches(provided: string | undefined): boolean {
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expected) return false;
  if (!provided || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/** Courier status pushes. Always answers 200 so the provider keeps the hook enabled. */
router.post("/webhook", async (req, res) => {
  if (!tokenMatches(req.headers["x-api-key"] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.status(200).json({ received: true });

  try {
    const payload = req.body ?? {};
    const awb = payload.awb ? String(payload.awb) : null;
    const providerOrderId = payload.sr_order_id ? String(payload.sr_order_id) : null;

    const shipment = awb
      ? await prisma.shipment.findFirst({ where: { awb } })
      : providerOrderId
        ? await prisma.shipment.findFirst({ where: { providerOrderId } })
        : null;

    if (!shipment) {
      console.warn("Shiprocket webhook for unknown shipment:", awb, providerOrderId);
      return;
    }

    const statusCode = payload.shipment_status_id != null ? Number(payload.shipment_status_id) : null;
    const status = payload.shipment_status ? String(payload.shipment_status) : null;

    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status,
        statusCode,
        awb: awb ?? shipment.awb,
        courierName: payload.courier_name ? String(payload.courier_name) : shipment.courierName,
        events: asJson(normalizeEvents(payload.scans ?? [])),
        lastSyncedAt: new Date(),
      },
    });

    const order = await prisma.order.findUnique({
      where: { id: shipment.orderId },
      select: { status: true },
    });

    const next = order ? nextOrderStatus(order.status, orderStatusFromCode(statusCode)) : null;
    if (next) {
      await prisma.order.update({
        where: { id: shipment.orderId },
        data: { status: next as never },
      });
    }
  } catch (error) {
    console.error("Shiprocket webhook processing failed:", error);
  }
});

export default router;
