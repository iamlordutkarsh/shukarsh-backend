import { Router } from "express";
import { z } from "zod";
import Razorpay from "razorpay";
import crypto from "crypto";
import { OrderStatus, ReturnOutcome, ReturnReason } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyToken } from "../lib/auth";
import { authenticate, requireAdmin } from "../middleware/auth";
import { quoteLimiter, recoveryLimiter } from "../middleware/rate-limit";
import { recoverLines } from "../lib/cart-recovery";
import { recordRedemption } from "../lib/coupon";
import { NotEnoughStockError, moveStock } from "../lib/inventory";
import { assignInvoiceNumber } from "../lib/invoice";
import { serializeProduct } from "../lib/product";
import { canonicalState, pincodeSchema, shippingAddressSchema } from "../lib/address";
import { buildQuote, serializeQuote } from "../lib/quote";
import { cartItemSchema } from "../lib/shipping";
import { serializeOrder } from "../lib/order";
import { isWebhookConfigured, markOrderPaid, paymentFromWebhook, verifyWebhookSignature } from "../lib/payment";
import { InsufficientStockError, applyOrderStatus } from "../lib/order-status";
import { sendOrderConfirmation, sendReturnRequested } from "../lib/notifications";
import {
  RETURN_PHOTO_LIMIT,
  photoRequired,
  returnBlockMessage,
  returnEligibility,
  returnInclude,
  serializeReturn,
} from "../lib/returns";
import { isCustomerUpload } from "../lib/storage";
import { handleWriteError } from "../lib/write-errors";

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
  items: z.array(cartItemSchema).min(1),
  shippingAddress: shippingAddressSchema,
  // Lowercased on the way in so an address is one identity however it was
  // capitalised. Coupon eligibility is decided by matching this against past
  // orders, and Rahul@Gmail.com not matching rahul@gmail.com is a free code.
  email: z.string().email().transform((value) => value.toLowerCase()),
  courierId: z.number().int().positive().optional(),
  couponCode: z.string().trim().max(40).optional(),
  paymentMethod: z.enum(["PREPAID", "COD"]).default("PREPAID"),
});

const quoteSchema = z.object({
  items: z.array(cartItemSchema).min(1),
  pincode: pincodeSchema.optional(),
  state: z.string().trim().min(2).optional(),
  courierId: z.number().int().positive().optional(),
  couponCode: z.string().trim().max(40).optional(),
  // The checkout page re-prices on every keystroke, so a half-typed address
  // arrives here constantly. Email only picks the identity a coupon limit
  // counts against, so an unusable one is dropped rather than failing the quote
  // and blanking the GST and discount the customer is looking at.
  email: z.string().email().optional().catch(undefined),
  paymentMethod: z.enum(["PREPAID", "COD"]).optional(),
});

const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

const statusSchema = z.object({ status: z.nativeEnum(OrderStatus) });

const returnRequestSchema = z.object({
  reason: z.nativeEnum(ReturnReason),
  outcome: z.nativeEnum(ReturnOutcome),
  // Required, and long enough to be a sentence. "Damaged" on its own cannot be
  // judged without writing back to ask what was damaged.
  note: z.string().trim().min(10).max(1000),
  // Only URLs our own uploader handed out. A browser decides what lands here, so
  // without this check the admin queue would happily render any address on the
  // internet, and evidence we do not host can be swapped after we have judged it.
  photos: z
    .array(z.string().url().refine(isCustomerUpload, "That photo was not uploaded here"))
    .max(RETURN_PHOTO_LIMIT)
    .default([]),
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        quantity: z.number().int().positive().max(20),
      })
    )
    .min(1),
});

const orderInclude = {
  user: { select: { email: true, firstName: true, lastName: true } },
  shipment: true,
  items: {
    include: {
      product: { select: { id: true, name: true, slug: true, images: true, hsn: true } },
    },
  },
  returns: { orderBy: { createdAt: "desc" }, include: returnInclude },
} as const;

/**
 * Who is asking, when signing in is optional.
 *
 * Both quoting and placing an order work for guests, but a signed-in customer
 * has to be recognised or per-customer coupon limits would count against the
 * wrong person.
 */
function optionalUserId(req: { headers: { authorization?: string } }): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;

  try {
    return verifyToken(header.slice(7)).id;
  } catch {
    return undefined;
  }
}

/**
 * What this bag would cost, worked out server-side.
 *
 * The checkout page needs the GST figure before an order exists, and every
 * number here has to come from the same code that /create will charge. Nothing
 * is written down and no payment is started.
 */
router.post("/quote", quoteLimiter, async (req, res) => {
  const result = quoteSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { items, pincode, state, courierId, couponCode, email, paymentMethod } = result.data;

  try {
    const quote = await buildQuote({
      items,
      pincode,
      // An unknown state just means we cannot tell intra from inter-state yet.
      state: state ? canonicalState(state) : null,
      courierId,
      couponCode,
      userId: optionalUserId(req),
      email,
      paymentMethod,
    });

    res.json(serializeQuote(quote));
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      res.status(statusCode).json({ error: (error as Error).message });
      return;
    }

    console.error("Quote failed:", error);
    res.status(500).json({ error: "Could not price this bag" });
  }
});

router.post("/create", async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { items, shippingAddress, email, courierId, couponCode, paymentMethod } = result.data;
  const userId = optionalUserId(req);

  try {
    // Prices are MRP, so the tax this returns is already inside totalAmount
    // rather than added on top. The customer pays the same either way.
    const quote = await buildQuote({
      items,
      pincode: shippingAddress.zip,
      state: shippingAddress.state,
      courierId,
      couponCode,
      userId,
      email,
      paymentMethod,
    });

    const { cart, shipping, tax, coupon, totalAmount } = quote;
    const isCod = quote.paymentMethod === "COD";

    if (cart.itemsTotal <= 0) {
      res.status(400).json({ error: "Cart total must be greater than zero" });
      return;
    }

    // Taking money for a parcel no courier will carry leaves the shop owing a
    // refund and the customer waiting for something that cannot come. The
    // checkout page already refuses, but it is the only thing that did, and a
    // page is not where a rule like this belongs. Only a definite no counts:
    // when we could not reach the courier at all, serviceable is null and the
    // order goes through, because our outage is not the customer's problem.
    if (shipping.serviceable === false) {
      res.status(409).json({
        error: `No courier is delivering to ${shippingAddress.zip} yet. Try another delivery address.`,
        unserviceable: true,
      });
      return;
    }

    // A code can expire or run out between the checkout page pricing it and the
    // customer pressing pay. Refusing here is better than quietly charging more
    // than the page last showed them.
    if (couponCode && quote.couponError) {
      res.status(409).json({ error: quote.couponError, couponRejected: true });
      return;
    }

    // The quote drops to prepaid quietly so a page can keep pricing, but by here
    // the customer has pressed a button that says cash on delivery. Charging
    // their card instead would be the wrong kind of helpful.
    if (paymentMethod === "COD" && !isCod) {
      res.status(409).json({ error: quote.codError, codRejected: true });
      return;
    }

    const amountInPaise = Math.round(totalAmount * 100);

    const razorpayOrder = isCod
      ? null
      : await getRazorpay().orders.create({
          amount: amountInPaise,
          currency: "INR",
          receipt: `order_${Date.now()}`,
          notes: {
            email,
            phone: shippingAddress.phone,
            pincode: shippingAddress.zip,
          },
        });

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          itemsTotal: cart.itemsTotal,
          shippingAmount: shipping.amount,
          paymentMethod: quote.paymentMethod,
          codFee: quote.codFee,
          discountTotal: quote.discountTotal,
          couponId: coupon?.couponId ?? null,
          couponCode: coupon?.code ?? null,
          totalAmount,
          taxTotal: tax.taxTotal,
          cgstTotal: tax.cgstTotal,
          sgstTotal: tax.sgstTotal,
          igstTotal: tax.igstTotal,
          placeOfSupply: tax.placeOfSupply,
          courierId: shipping.courierId,
          courierName: shipping.courierName,
          shippingAddress,
          email,
          customerName: shippingAddress.name,
          customerPhone: shippingAddress.phone,
          razorpayOrderId: razorpayOrder?.id ?? null,
          userId,
          items: {
            // Indexed by position, not product id: computeTax maps over the lines
            // it was given, so index i lines up even if a cart somehow carries the
            // same product twice.
            create: cart.lines.map((line, index) => ({
              productId: line.productId,
              variantId: line.variantId,
              // The names as well as the link: a colour or size that is later
              // renamed or withdrawn must not change what this invoice says was
              // bought.
              variantLabel: line.variantLabel,
              variantColour: line.variantColour,
              quantity: line.quantity,
              price: line.price,
              // The rate tax was actually worked out at, not the product's, so a
              // row never claims a rate applied while recording no tax.
              gstRate: tax.lines[index]?.rate ?? line.gstRate,
              taxableAmount: tax.lines[index]?.taxable ?? line.gross,
              taxAmount: tax.lines[index]?.tax ?? 0,
              // Snapshotted for the same reason as the rate: renegotiating with a
              // supplier must not rewrite the profit on orders already shipped.
              costPrice: line.costPrice,
            })),
          },
        },
      });

      /**
       * Cash orders take stock at placement. No payment event is coming before
       * the parcel leaves, so waiting for one would let two COD orders sell the
       * same unit. Conditional, unlike the paid path: nothing has been collected
       * yet, so refusing an order we cannot fill costs nothing, while
       * overselling costs a cancellation and a customer.
       */
      if (isCod) {
        for (const line of cart.lines) {
          await moveStock(tx, {
            productId: line.productId,
            variantId: line.variantId,
            delta: -line.quantity,
            reason: "SALE",
            orderId: created.id,
          });
        }

        // Prepaid books this the moment the money lands. Cash has no such moment
        // before dispatch, so without this a single-use code stays reusable
        // forever by choosing COD.
        if (coupon) {
          await recordRedemption(tx, {
            couponId: coupon.couponId,
            orderId: created.id,
            userId: userId ?? null,
            email,
            amount: quote.discountTotal,
          });
        }

        // Cash never has a payment moment before the parcel goes out, so the
        // order being placed is the only point at which to number it. Prepaid is
        // numbered when the money lands instead, in markOrderPaid.
        await assignInvoiceNumber(tx, created.id);
      }

      return created;
    });

    // A cash order has nothing to confirm through Razorpay, so this is the only
    // moment it gets acknowledged. Prepaid waits for the payment to land.
    if (isCod) {
      void sendOrderConfirmation(order.id).catch((error) =>
        console.error("COD confirmation email failed:", error)
      );
    }

    res.json({
      orderId: order.id,
      razorpayOrderId: razorpayOrder?.id ?? null,
      amount: amountInPaise,
      currency: "INR",
      keyId: razorpayOrder ? process.env.RAZORPAY_KEY_ID : null,
      paymentMethod: quote.paymentMethod,
      codFee: quote.codFee,
      itemsTotal: cart.itemsTotal,
      discountTotal: quote.discountTotal,
      shippingAmount: shipping.amount,
      totalAmount,
      courierName: shipping.courierName,
      coupon: coupon ? { code: coupon.code, discount: coupon.discount, freeShipping: coupon.freeShipping } : null,
      tax: {
        enabled: tax.enabled,
        total: tax.taxTotal,
        cgst: tax.cgstTotal,
        sgst: tax.sgstTotal,
        igst: tax.igstTotal,
        intraState: tax.intraState,
      },
    });
  } catch (error) {
    // Only reachable on a cash order, where stock is taken before any money is
    // promised. The whole transaction is rolled back, so no half-order survives.
    if (error instanceof NotEnoughStockError) {
      res.status(409).json({
        error: "Someone just took the last one. Check the bag and try again.",
        outOfStock: true,
      });
      return;
    }

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
    // Both misconfigurations look identical from outside, so name them here.
    console.warn(
      isWebhookConfigured()
        ? "Razorpay webhook rejected: signature mismatch. The secret in Razorpay does not match RAZORPAY_WEBHOOK_SECRET."
        : "Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not set, so every delivery will fail."
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Answer immediately so Razorpay does not retry a slow but successful call.
  res.status(200).json({ received: true });

  try {
    const payment = paymentFromWebhook(req.body);
    if (!payment) {
      console.log("Razorpay webhook accepted, no action for event:", req.body?.event);
      return;
    }

    const result = await markOrderPaid(payment);

    if (!result) {
      console.warn("Razorpay webhook for unknown order:", payment.razorpayOrderId);
      return;
    }

    if (result.alreadyPaid) {
      console.log("Razorpay webhook verified, order already confirmed by the browser:", result.orderId);
      return;
    }

    console.log("Razorpay webhook confirmed a payment the browser never reported:", result.orderId);
    void sendOrderConfirmation(result.orderId);
  } catch (error) {
    console.error("Razorpay webhook processing failed:", error);
  }
});

/**
 * Rebuilds a bag from a checkout that was never paid for.
 *
 * Public, because the link arrives by email and the customer may well not have an
 * account. The signature is what stands in for a login, and it grants exactly one
 * thing: the products and quantities that were picked out. No address, no totals,
 * nothing about the person.
 *
 * Only products still on sale come back, so a link followed weeks later quietly
 * drops what has since been withdrawn rather than offering it.
 */
router.get("/:id/recover", recoveryLimiter, async (req, res) => {
  const lines = await recoverLines(req.params.id as string, String(req.query.token ?? ""));
  if (!lines) return res.status(404).json({ error: "This link is no longer valid" });

  const products = await prisma.product.findMany({
    where: { id: { in: lines.map((line) => line.productId) }, isActive: true },
    // Options included, or serializeProduct reports "sells as one thing" and the
    // recovered bag cannot be repaired: the storefront reads an empty array as
    // an answer rather than as a question this query never asked.
    include: {
      category: { select: { id: true, name: true, slug: true } },
      variants: { orderBy: [{ position: "asc" }, { label: "asc" }] },
      colours: { orderBy: [{ position: "asc" }, { name: "asc" }] },
    },
  });

  const quantityOf = new Map(lines.map((line) => [line.productId, line.quantity]));

  res.json({
    items: products.map((product) => ({
      product: serializeProduct(product),
      quantity: quantityOf.get(product.id) ?? 1,
    })),
  });
});

router.get("/", authenticate, async (req, res) => {
  const where = req.user!.role === "ADMIN" ? {} : { userId: req.user!.id };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: orderInclude,
  });

  // Wrapped rather than passed straight to map, or the array index would land
  // in the options slot.
  const includeCost = req.user!.role === "ADMIN";
  res.json({ orders: orders.map((order) => serializeOrder(order, { includeCost })) });
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

  res.json({ order: serializeOrder(order, { includeCost: req.user!.role === "ADMIN" }) });
});

/**
 * Lets the customer call an order off themselves, but only while it is still
 * waiting to be approved. Once the shop moves it to Processing someone is
 * packing it, and from there a cancellation has to go through them.
 */
router.post("/:id/cancel", authenticate, async (req, res) => {
  const id = req.params.id as string;
  const order = await prisma.order.findUnique({ where: { id }, select: { userId: true, status: true } });

  // Same shape as the fetch above: an order that is not yours does not exist.
  if (!order || order.userId !== req.user!.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (order.status !== "PENDING") {
    res.status(409).json({
      error:
        order.status === "CANCELLED"
          ? "This order is already cancelled."
          : "This order has already been approved, so it can no longer be cancelled here. Please contact us.",
    });
    return;
  }

  try {
    await applyOrderStatus(id, "CANCELLED");
    const updated = await prisma.order.findUnique({ where: { id }, include: orderInclude });
    res.json({ order: serializeOrder(updated!) });
  } catch (error) {
    console.error("Customer order cancellation failed:", error);
    res.status(500).json({ error: "Could not cancel this order" });
  }
});

/**
 * Opens a return against a delivered order.
 *
 * Signing in is required, which leaves guests to email us: an order with no
 * account behind it cannot be proved to belong to whoever is asking, and a
 * return request is a claim on money.
 */
router.post("/:id/returns", authenticate, async (req, res) => {
  const result = returnRequestSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });

  // Same shape as fetching one: an order that is not yours does not exist.
  if (!order || order.userId !== req.user!.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const eligibility = returnEligibility(order);
  if (!eligibility.open) {
    res.status(409).json({ error: returnBlockMessage(eligibility.block!) });
    return;
  }

  if (photoRequired(result.data.reason) && result.data.photos.length === 0) {
    res.status(400).json({
      error: "Please add at least one photo of the damage so we can see what happened.",
    });
    return;
  }

  // Collapsed first, for the reason the bag is: the same line sent twice would
  // pass the check on each half and together claim more than was bought.
  const asked = new Map<string, number>();
  for (const line of result.data.items) {
    asked.set(line.orderItemId, (asked.get(line.orderItemId) ?? 0) + line.quantity);
  }

  for (const [orderItemId, quantity] of asked) {
    const available = eligibility.available[orderItemId];

    if (available === undefined) {
      res.status(400).json({ error: "One of those items is not on this order" });
      return;
    }

    if (quantity > available) {
      const name = order.items.find((item) => item.id === orderItemId)?.product.name ?? "that item";
      res.status(409).json({
        error:
          available === 0
            ? `${name} has already been returned.`
            : `You can only send back ${available} of ${name}.`,
      });
      return;
    }
  }

  try {
    const created = await prisma.returnRequest.create({
      data: {
        orderId: order.id,
        userId: req.user!.id,
        reason: result.data.reason,
        outcome: result.data.outcome,
        customerNote: result.data.note,
        photos: result.data.photos,
        items: {
          create: [...asked].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        },
      },
      include: returnInclude,
    });

    void sendReturnRequested(created.id);
    res.status(201).json({ return: serializeReturn(created) });
  } catch (error) {
    handleWriteError(res, error, { fallback: "Could not open this return" });
  }
});

/** Lets a customer take back a request we have not decided on yet. */
router.post("/:id/returns/:returnId/withdraw", authenticate, async (req, res) => {
  const returnId = req.params.returnId as string;
  const request = await prisma.returnRequest.findUnique({
    where: { id: returnId },
    select: { id: true, status: true, orderId: true, order: { select: { userId: true } } },
  });

  if (!request || request.orderId !== req.params.id || request.order.userId !== req.user!.id) {
    res.status(404).json({ error: "Return not found" });
    return;
  }

  if (request.status !== "REQUESTED") {
    res.status(409).json({
      error:
        request.status === "WITHDRAWN"
          ? "This return was already withdrawn."
          : "We have already started on this return, so please talk to us rather than closing it here.",
    });
    return;
  }

  try {
    const updated = await prisma.returnRequest.update({
      where: { id: returnId },
      data: { status: "WITHDRAWN" },
      include: returnInclude,
    });

    res.json({ return: serializeReturn(updated) });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Return not found",
      fallback: "Could not withdraw this return",
    });
  }
});

router.patch("/:id/status", authenticate, requireAdmin, async (req, res) => {
  const result = statusSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const id = req.params.id as string;

  try {
    const change = await applyOrderStatus(id, result.data.status);
    if (!change) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
    res.json({ order: serializeOrder(order!, { includeCost: true }) });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      res.status(409).json({
        error: "Reopening this order needs more stock than the catalogue has. Restock it first.",
      });
      return;
    }

    console.error("Order status update error:", error);
    res.status(500).json({ error: "Could not update this order" });
  }
});

export default router;
