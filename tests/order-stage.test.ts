import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORDER_STAGES, foldStageCounts, inStage, stageWhere } from "../src/lib/order-stage";

const order = (status: string, paymentStatus: string, paymentMethod = "PREPAID") => ({
  status,
  paymentStatus,
  paymentMethod,
});

/**
 * The queues, which are not the same thing as the statuses.
 *
 * What makes these worth testing is that two of them turn on the payment rather
 * than the status, and both of those are the difference between a shop seeing
 * its work and a shop staring at an approval queue with the wrong things in it.
 */
describe("inStage", () => {
  it("puts a paid pending order in the approval queue", () => {
    assert.equal(inStage(order("PENDING", "PAID"), "PENDING"), true);
  });

  it("keeps an abandoned checkout out of it", () => {
    assert.equal(inStage(order("PENDING", "PENDING"), "PENDING"), false);
    assert.equal(inStage(order("PENDING", "PENDING"), "UNPAID"), true);
  });

  it("treats a cash order as real work even though nobody has paid", () => {
    const cash = order("PENDING", "PENDING", "COD");
    assert.equal(inStage(cash, "PENDING"), true);
    assert.equal(inStage(cash, "UNPAID"), false);
  });

  it("counts cancelled and returned as closed, not as unpaid", () => {
    assert.equal(inStage(order("CANCELLED", "PENDING"), "CLOSED"), true);
    assert.equal(inStage(order("CANCELLED", "PENDING"), "UNPAID"), false);
    assert.equal(inStage(order("RETURNED", "PAID"), "CLOSED"), true);
  });

  it("puts everything in ALL", () => {
    assert.equal(inStage(order("CANCELLED", "FAILED"), "ALL"), true);
    assert.equal(inStage(order("DELIVERED", "PAID"), "ALL"), true);
  });

  it("does not let a cancelled order show up in the queue it was cancelled from", () => {
    assert.equal(inStage(order("CANCELLED", "PAID"), "PENDING"), false);
  });
});

describe("stageWhere", () => {
  it("narrows nothing for ALL, so it can be spread over an owner filter", () => {
    assert.deepEqual(stageWhere("ALL"), {});
  });

  it("asks for both halves of the settled rule on a fulfilment queue", () => {
    const where = stageWhere("SHIPPED") as { status?: string; OR?: unknown[] };
    assert.equal(where.status, "SHIPPED");
    assert.deepEqual(where.OR, [{ paymentStatus: "PAID" }, { paymentMethod: "COD" }]);
  });

  it("excludes the closed statuses from unpaid", () => {
    const where = stageWhere("UNPAID") as { status?: { notIn?: string[] } };
    assert.deepEqual(where.status?.notIn, ["CANCELLED", "RETURNED"]);
  });
});

describe("foldStageCounts", () => {
  /**
   * The badges are folded out of one grouped read rather than counted per queue,
   * so the arithmetic has to be right: a total that disagreed with the list it
   * labels sends somebody hunting for an order that is not there.
   */
  it("counts one order into every queue it belongs to", () => {
    const counts = foldStageCounts([
      { ...order("PENDING", "PAID"), _count: { _all: 3 } },
      { ...order("PENDING", "PENDING"), _count: { _all: 5 } },
      { ...order("PENDING", "PENDING", "COD"), _count: { _all: 2 } },
      { ...order("SHIPPED", "PAID"), _count: { _all: 4 } },
      { ...order("CANCELLED", "PENDING"), _count: { _all: 1 } },
    ]);

    // Paid pending plus the cash ones, which are work whatever the payment says.
    assert.equal(counts.PENDING, 5);
    assert.equal(counts.UNPAID, 5);
    assert.equal(counts.SHIPPED, 4);
    assert.equal(counts.CLOSED, 1);
    assert.equal(counts.ALL, 15);
  });

  it("reports every queue even when the shop has no orders", () => {
    const counts = foldStageCounts([]);
    for (const stage of ORDER_STAGES) assert.equal(counts[stage], 0);
  });

  it("adds the queues up to no more than the whole, ignoring ALL", () => {
    const groups = [
      { ...order("PENDING", "PAID"), _count: { _all: 3 } },
      { ...order("DELIVERED", "PAID"), _count: { _all: 7 } },
      { ...order("RETURNED", "PAID"), _count: { _all: 2 } },
      { ...order("PROCESSING", "FAILED"), _count: { _all: 1 } },
    ];
    const counts = foldStageCounts(groups);
    const queues = ORDER_STAGES.filter((stage) => stage !== "ALL").reduce(
      (sum, stage) => sum + counts[stage],
      0
    );

    // Every order lands in exactly one queue, so the parts equal the whole.
    assert.equal(queues, counts.ALL);
    assert.equal(counts.ALL, 13);
  });
});
