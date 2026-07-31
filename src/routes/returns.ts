import { Router } from "express";
import { z } from "zod";
import { ReturnStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authenticate, requireAdmin } from "../middleware/auth";
import { applyOrderStatus } from "../lib/order-status";
import { moveStock } from "../lib/inventory";
import { sendReturnCompleted, sendReturnDecision } from "../lib/notifications";
import {
  canTransition,
  refundBreakdown,
  returnInclude,
  serializeAdminReturn,
} from "../lib/returns";
import { RefundError, issueRefund } from "../lib/refunds";
import { handleWriteError } from "../lib/write-errors";

const router = Router();

const adminInclude = {
  ...returnInclude,
  order: {
    include: {
      items: true,
      // The other returns on the order, to see whether this one finishes it off.
      returns: { select: { id: true, status: true, items: { select: { orderItemId: true, quantity: true } } } },
      user: { select: { email: true } },
    },
  },
} as const;

const decisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "RECEIVED", "COMPLETED"]),
  adminNote: z.string().trim().max(1000).optional(),
  /** Required when marking a parcel received: one verdict per returned line. */
  items: z
    .array(z.object({ orderItemId: z.string().min(1), resellable: z.boolean() }))
    .optional(),
});

router.get("/", authenticate, requireAdmin, async (req, res) => {
  const status = req.query.status;
  const filter =
    typeof status === "string" && status in ReturnStatus
      ? { status: status as ReturnStatus }
      : {};

  const requests = await prisma.returnRequest.findMany({
    where: filter,
    // Oldest first: this is a queue, and the person who has waited longest is
    // the one owed an answer.
    orderBy: { createdAt: "asc" },
    include: adminInclude,
  });

  res.json({ returns: requests.map(serializeAdminReturn) });
});

/**
 * Moves a return along: accept it, refuse it, log the parcel arriving, or close
 * it once the money or the replacement has gone out.
 *
 * The states are a one-way street, so a refused return cannot quietly become an
 * approved one and a closed one cannot be reopened for a second refund.
 */
router.patch("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = decisionSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;
  const next = result.data.status;
  const request = await prisma.returnRequest.findUnique({ where: { id }, include: adminInclude });

  if (!request) {
    res.status(404).json({ error: "Return not found" });
    return;
  }

  if (!canTransition(request.status, next)) {
    res.status(409).json({
      error: `A return that is ${request.status.toLowerCase()} cannot be marked ${next.toLowerCase()}.`,
    });
    return;
  }

  // Refusing someone costs them money, so it does not happen without a reason
  // they can read.
  if (next === "REJECTED" && !result.data.adminNote) {
    res.status(400).json({ error: "Say why you are refusing this. The customer is told." });
    return;
  }

  const verdicts = new Map((result.data.items ?? []).map((item) => [item.orderItemId, item.resellable]));

  if (next === "RECEIVED") {
    const undecided = request.items.filter((item) => !verdicts.has(item.orderItemId));
    if (undecided.length > 0) {
      res.status(400).json({
        error: "Say for each item whether it can be sold again before marking the parcel received.",
      });
      return;
    }
  }

  const now = new Date();

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (next === "RECEIVED") {
        // Only what came back and can be sold again goes on the shelf. A soaked
        // dress is a loss, not stock, and counting it would promise a customer
        // something we cannot send.
        for (const item of request.items) {
          if (verdicts.get(item.orderItemId) !== true) continue;
          const line = request.order.items.find((orderItem) => orderItem.id === item.orderItemId);
          if (!line) continue;

          await moveStock(tx, {
            productId: line.productId,
            // Back to the shelf it left, so a returned medium does not quietly
            // become a large the catalogue thinks it can sell.
            variantId: line.variantId,
            delta: item.quantity,
            reason: "RETURN_RESTOCK",
            orderId: request.orderId,
            userId: req.user!.id,
          });
        }

        for (const item of request.items) {
          await tx.returnItem.update({
            where: { id: item.id },
            data: { resellable: verdicts.get(item.orderItemId) ?? null },
          });
        }
      }

      return tx.returnRequest.update({
        where: { id },
        data: {
          status: next,
          ...(result.data.adminNote ? { adminNote: result.data.adminNote } : {}),
          ...(next === "APPROVED" || next === "REJECTED" ? { decidedAt: now } : {}),
          ...(next === "RECEIVED" ? { receivedAt: now } : {}),
          ...(next === "COMPLETED" ? { completedAt: now } : {}),
          // Frozen on approval, from what was actually paid for these lines.
          ...(next === "APPROVED"
            ? {
                refundAmount: refundBreakdown(
                  request.order,
                  request.items.map((item) => ({
                    orderItemId: item.orderItemId,
                    quantity: item.quantity,
                  }))
                ).total,
              }
            : {}),
        },
        include: adminInclude,
      });
    });

    // Once every unit of the order is back, the order itself is a return. The
    // stock was just moved by hand above, so this only writes the status: it must
    // not put the same units back a second time. A failure here leaves the return
    // correct and the order status stale, which the orders panel can fix.
    if (next === "RECEIVED" && coversWholeOrder(request)) {
      await applyOrderStatus(request.orderId, "RETURNED", { stockHandledElsewhere: true });
    }

    if (next === "APPROVED" || next === "REJECTED") void sendReturnDecision(id);
    if (next === "COMPLETED") void sendReturnCompleted(id);

    res.json({ return: serializeAdminReturn(updated) });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Return not found",
      fallback: "Could not update this return",
    });
  }
});

/**
 * Sends the money back for a return whose goods have arrived.
 *
 * Its own action rather than a side effect of closing the return, so nothing
 * leaves the account without somebody meaning it. Safe to press again: the return
 * id is the idempotency key at Razorpay's end, and refundId is unique at ours.
 *
 * The refund is what closes the return, since that is what the customer was
 * promised. An exchange has no money in it and is closed by hand as before.
 */
router.post("/:id/refund", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const request = await prisma.returnRequest.findUnique({ where: { id }, include: adminInclude });

  if (!request) {
    res.status(404).json({ error: "Return not found" });
    return;
  }

  if (request.refundId) {
    res.status(409).json({ error: "This return has already been refunded." });
    return;
  }

  if (request.outcome !== "REFUND") {
    res.status(400).json({ error: "This return was agreed as an exchange, so there is nothing to refund." });
    return;
  }

  // The goods have to be back first. Approving a return is a promise; paying for
  // one before it arrives is a donation.
  if (request.status !== "RECEIVED" && request.status !== "COMPLETED") {
    res.status(409).json({ error: "Mark the parcel as received before sending any money back." });
    return;
  }

  const paymentId = request.order.razorpayPaymentId;
  if (!paymentId) {
    res.status(400).json({
      error: "No Razorpay payment is recorded against this order, so it has to be refunded by hand.",
    });
    return;
  }

  // The figure frozen at approval, not one worked out again now: a price change
  // since then must not move what this customer is owed.
  const amount = Number(request.refundAmount ?? 0);
  if (amount <= 0) {
    res.status(400).json({ error: "This return has no refund amount on it." });
    return;
  }

  try {
    const refund = await issueRefund({
      returnId: id,
      paymentId,
      amountRupees: amount,
      orderReference: request.orderId.slice(0, 8).toUpperCase(),
    });

    const now = new Date();
    const updated = await prisma.returnRequest.update({
      where: { id },
      data: {
        refundId: refund.id,
        refundedAt: now,
        refundStatus: refund.status,
        refundError: null,
        ...(request.status === "RECEIVED" ? { status: "COMPLETED", completedAt: now } : {}),
      },
      include: adminInclude,
    });

    if (request.status === "RECEIVED") void sendReturnCompleted(id);

    res.json({ return: serializeAdminReturn(updated) });
  } catch (error) {
    const failure =
      error instanceof RefundError ? error : new RefundError("Could not send the refund", 500, true);

    // Recorded on the return rather than only logged, so whoever looks next can
    // see what happened. The refund id stays empty, so the button stays available.
    await prisma.returnRequest
      .update({ where: { id }, data: { refundError: failure.message } })
      .catch(() => undefined);

    console.error(`Refund failed for return ${id}:`, error);
    res.status(failure.retryable ? 502 : 400).json({ error: failure.message });
  }
});

const manualRefundSchema = z.object({
  /**
   * The UPI or bank reference for money that has already left. Stored in the
   * same column as a Razorpay refund id, which is unique, so pasting one
   * reference against two returns is refused rather than double counted.
   */
  reference: z.string().trim().min(4).max(64),
});

/**
 * Records a refund that was paid by hand.
 *
 * A cash order has no payment to reverse, so the money goes out over UPI and
 * this is what makes the shop's own records agree with its bank. Deliberately a
 * separate route: it moves nothing, it only writes down what a human already
 * did, and mixing that into the button that actually moves money would make it
 * possible to close a return by typing a reference.
 */
router.post("/:id/refund/manual", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const parsed = manualRefundSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter the UPI or bank reference for the payment you made." });
    return;
  }

  const request = await prisma.returnRequest.findUnique({ where: { id }, include: adminInclude });

  if (!request) {
    res.status(404).json({ error: "Return not found" });
    return;
  }

  if (request.refundId) {
    res.status(409).json({ error: "This return has already been refunded." });
    return;
  }

  if (request.outcome !== "REFUND") {
    res.status(400).json({ error: "This return was agreed as an exchange, so there is nothing to refund." });
    return;
  }

  if (request.status !== "RECEIVED" && request.status !== "COMPLETED") {
    res.status(409).json({ error: "Mark the parcel as received before recording any money back." });
    return;
  }

  // An order with a Razorpay payment must go back the way it came, or the
  // customer is refunded twice and the books never reconcile.
  if (request.order.razorpayPaymentId) {
    res.status(400).json({
      error: "This order was paid through Razorpay, so refund it with the button above instead.",
    });
    return;
  }

  const amount = Number(request.refundAmount ?? 0);
  if (amount <= 0) {
    res.status(400).json({ error: "This return has no refund amount on it." });
    return;
  }

  try {
    const now = new Date();
    const updated = await prisma.returnRequest.update({
      where: { id },
      data: {
        refundId: parsed.data.reference,
        refundedAt: now,
        refundStatus: "manual",
        refundError: null,
        ...(request.status === "RECEIVED" ? { status: "COMPLETED", completedAt: now } : {}),
      },
      include: adminInclude,
    });

    if (request.status === "RECEIVED") void sendReturnCompleted(id);

    res.json({ return: serializeAdminReturn(updated) });
  } catch (error) {
    handleWriteError(res, error, {
      duplicate: "That reference is already recorded against another refund.",
      fallback: "Could not record this refund",
    });
  }
});

/**
 * Whether every unit on the order has now come back.
 *
 * Counted across all the returns that reached us, not just this one: a customer
 * who sends back one dress in March and the other in April has still returned
 * the whole order by April, and the order should say so.
 */
function coversWholeOrder(request: {
  id: string;
  items: { orderItemId: string; quantity: number }[];
  order: {
    items: { id: string; quantity: number }[];
    returns: { id: string; status: string; items: { orderItemId: string; quantity: number }[] }[];
  };
}): boolean {
  const back = new Map<string, number>();

  const add = (items: { orderItemId: string; quantity: number }[]) => {
    for (const item of items) {
      back.set(item.orderItemId, (back.get(item.orderItemId) ?? 0) + item.quantity);
    }
  };

  for (const other of request.order.returns) {
    // This one was read before the update, so its own row still says APPROVED.
    if (other.id === request.id) continue;
    if (other.status !== "RECEIVED" && other.status !== "COMPLETED") continue;
    add(other.items);
  }
  add(request.items);

  return request.order.items.every((line) => (back.get(line.id) ?? 0) >= line.quantity);
}

export default router;
