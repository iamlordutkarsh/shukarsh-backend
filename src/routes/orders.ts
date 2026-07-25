import { Router } from "express";
import { z } from "zod";
import Razorpay from "razorpay";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { verifyToken } from "../lib/auth";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

function getRazorpay(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay keys are not configured");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const shippingAddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  zip: z.string().min(1),
  country: z.string().default("US"),
});

const createOrderSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive(),
      name: z.string().min(1),
      price: z.number().positive(),
      image: z.string().optional(),
    })
  ),
  shippingAddress: shippingAddressSchema,
  email: z.string().email(),
});

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

router.post("/create", async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { items, shippingAddress, email } = result.data;
  const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  let userId: string | undefined;
  if (token) {
    try {
      const payload = verifyToken(token);
      userId = payload.id;
    } catch {
      userId = undefined;
    }
  }

  if (totalAmount <= 0) {
    res.status(400).json({ error: "Cart total must be greater than zero" });
    return;
  }

  try {
    const razorpay = getRazorpay();
    const amountInPaise = Math.round(totalAmount * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `order_${Date.now()}`,
      notes: {
        email,
        shippingAddress: JSON.stringify(shippingAddress),
      },
    });

    const order = await prisma.order.create({
      data: {
        totalAmount: totalAmount,
        shippingAddress: shippingAddress,
        razorpayOrderId: razorpayOrder.id,
        userId: userId,
        email: email,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
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
    });
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    res.status(500).json({ error: "Failed to create Razorpay order" });
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
    const order = await prisma.order.update({
      where: { razorpayOrderId },
      data: {
        paymentStatus: "PAID",
        razorpayPaymentId,
        razorpaySignature,
      },
    });

    res.json({ message: "Payment verified", orderId: order.id });
  } catch (error) {
    res.status(404).json({ error: "Order not found" });
  }
});

function serializeOrder(order: any) {
  const { user, ...rest } = order;

  return {
    ...rest,
    totalAmount: Number(order.totalAmount),
    customerEmail: order.email ?? user?.email ?? null,
    customerName: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null,
    items: order.items.map((item: any) => ({ ...item, price: Number(item.price) })),
  };
}

router.get("/", authenticate, async (req, res) => {
  const where = req.user!.role === "ADMIN" ? {} : { userId: req.user!.id };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true, firstName: true, lastName: true } },
      items: {
        include: {
          product: { select: { id: true, name: true, slug: true, images: true } },
        },
      },
    },
  });

  res.json({ orders: orders.map(serializeOrder) });
});

export default router;
