import { Router } from "express";
import { z } from "zod";
import Razorpay from "razorpay";
import crypto from "crypto";
import { OrderStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyToken } from "../lib/auth";
import { authenticate, requireAdmin } from "../middleware/auth";
import { shippingAddressSchema } from "../lib/address";
import { priceCart, resolveShipping } from "../lib/shipping";
import { serializeOrder } from "../lib/order";
import { markOrderPaid, paymentFromWebhook, verifyWebhookSignature } from "../lib/payment";
import { sendOrderConfirmation } from "../lib/notifications";

const router = Router();

function getRazorpay(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay keys are not configured");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const createOrderSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive().max(20),
    })
  ).min(1),
  shippingAddress: shippingAddressSchema,
  email: z.string().email(),
  courierId: z.number().int().positive().optional(),
});

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

const statusSchema = z.object({ status: z.nativeEnum(OrderStatus) });

const orderInclude = {
  user: { select: { email: true, firstName: true, lastName: true } },
  shipment: true,
  items: {
    include: {
      product: { select: { id: true, name: true, slug: true, images: true } },
    },
  },
} as const;

router.post("/create", async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { items, shippingAddress, email, courierId } = result.data;

  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  let userId: string | undefined;
  if (token) {
    try {
      userId = verifyToken(token).id;
    } catch {
      userId = undefined;
    }
  }

  try {
    const cart = await priceCart(items);
    if (cart.itemsTotal <= 0) {
      res.status(400).json({ error: "Cart total must be greater than zero" });
      return;
    }

    const shipping = await resolveShipping({
      pincode: shippingAddress.zip,
      parcel: cart.parcel,
      declaredValue: cart.itemsTotal,
      preferredCourierId: courierId,
    });

    const totalAmount = cart.itemsTotal + shipping.amount;
    const razorpay = getRazorpay();
    const amountInPaise = Math.round(totalAmount * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `order_${Date.now()}`,
      notes: {
        email,
        phone: shippingAddress.phone,
        pincode: shippingAddress.zip,
      },
    });

    const order = await prisma.order.create({
      data: {
        itemsTotal: cart.itemsTotal,
        shippingAmount: shipping.amount,
        totalAmount,
        courierId: shipping.courierId,
        courierName: shipping.courierName,
        shippingAddress,
        email,
        customerName: shippingAddress.name,
        customerPhone: shippingAddress.phone,
        razorpayOrderId: razorpayOrder.id,
        userId,
        items: {
          create: cart.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            price: line.price,
          })),
        },
      },
    });

    res.json({
      orderId: order.id,
      razorpayOrderId: razorpayOrder.id,
      amount: amountInPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      itemsTotal: cart.itemsTotal,
      shippingAmount: shipping.amount,
      totalAmount,
      courierName: shipping.courierName,
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      res.status(statusCode).json({ error: (error as Error).message });
      return;
    }

    console.error("Order creation error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.post("/verify", async (req, res) => {
  const result = verifyPaymentSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = result.data;

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Razorpay secret is not configured" });
    return;
  }

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  if (expectedSignature !== razorpaySignature) {
    res.status(400).json({ error: "Invalid payment signature" });
    return;
  }

  try {
    const result = await markOrderPaid({ razorpayOrderId, razorpayPaymentId, razorpaySignature });

    if (!result) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (!result.alreadyPaid) void sendOrderConfirmation(result.orderId);

    res.json({ message: "Payment verified", orderId: result.orderId });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: "Could not confirm this payment" });
  }
});

/**
 * Razorpay's own confirmation. The browser callback above is the fast path, but
 * it never fires if the customer closes the tab, so this is what stops a
 * captured payment from leaving an order stuck on PENDING.
 */
router.post("/webhook", async (req, res) => {
  if (!verifyWebhookSignature(req.rawBody, req.headers["x-razorpay-signature"] as string | undefined)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Answer immediately so Razorpay does not retry a slow but successful call.
  res.status(200).json({ received: true });

  try {
    const payment = paymentFromWebhook(req.body);
    if (!payment) return;

    const result = await markOrderPaid(payment);

    if (!result) {
      console.warn("Razorpay webhook for unknown order:", payment.razorpayOrderId);
      return;
    }

    if (!result.alreadyPaid) {
      console.log("Razorpay webhook confirmed payment the browser never reported:", result.orderId);
      void sendOrderConfirmation(result.orderId);
    }
  } catch (error) {
    console.error("Razorpay webhook processing failed:", error);
  }
});

router.get("/", authenticate, async (req, res) => {
  const where = req.user!.role === "ADMIN" ? {} : { userId: req.user!.id };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: orderInclude,
  });

  res.json({ orders: orders.map(serializeOrder) });
});

router.get("/:id", authenticate, async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id as string },
    include: orderInclude,
  });

  if (!order || (req.user!.role !== "ADMIN" && order.userId !== req.user!.id)) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  res.json({ order: serializeOrder(order) });
});

router.patch("/:id/status", authenticate, requireAdmin, async (req, res) => {
  const result = statusSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const id = req.params.id as string;

  try {
    const current = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!current) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const nextStatus = result.data.status;
    const shouldRelease =
      !current.stockReleased &&
      current.paymentStatus === "PAID" &&
      (nextStatus === "CANCELLED" || nextStatus === "RETURNED");

    const order = await prisma.$transaction(async (tx) => {
      if (shouldRelease) {
        for (const item of current.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      return tx.order.update({
        where: { id },
        data: { status: nextStatus, ...(shouldRelease ? { stockReleased: true } : {}) },
        include: orderInclude,
      });
    });

    res.json({ order: serializeOrder(order) });
  } catch (error) {
    console.error("Order status update error:", error);
    res.status(500).json({ error: "Could not update this order" });
  }
});

export default router;
