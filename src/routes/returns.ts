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
