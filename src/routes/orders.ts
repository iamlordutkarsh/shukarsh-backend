import { Router } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2026-06-24.dahlia",
});

const shippingAddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  zip: z.string().min(1),
  country: z.string().default("US"),
});

const checkoutSchema = z.object({
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

router.post("/checkout", async (req, res) => {
  const result = checkoutSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { items, shippingAddress, email } = result.data;
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (totalAmount <= 0) {
    res.status(400).json({ error: "Cart total must be greater than zero" });
    return;
  }

  try {
    const lineItems = items.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : undefined,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/checkout/cancel`,
      customer_email: email,
      metadata: {
        shippingAddress: JSON.stringify(shippingAddress),
      },
    });

    const order = await prisma.order.create({
      data: {
        totalAmount: totalAmount,
        shippingAddress: shippingAddress,
        stripeSessionId: session.id,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      },
    });

    res.json({ orderId: order.id, sessionUrl: session.url });
  } catch (error) {
    console.error("Checkout error:", error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

router.get("/", authenticate, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, slug: true, images: true } },
        },
      },
    },
  });

  res.json({ orders });
});

export default router;
