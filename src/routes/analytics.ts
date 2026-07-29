import { Router } from "express";
import { analyticsSummary, windowDays } from "../lib/analytics";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

/**
 * Everything the shop's own numbers can honestly say.
 *
 * Admin only and never cached: these are takings, costs and margins. The response
 * says nothing about visitors or where they came from, because nothing here tracks
 * that; the funnel starts at the first thing put in a bag.
 */
router.get("/summary", authenticate, requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");

  try {
    res.json({ summary: await analyticsSummary(windowDays(req.query.days)) });
  } catch (error) {
    console.error("Analytics summary failed:", error);
    // Only an admin ever sees this, and they are the one person who can act on it.
    // A page that fails with nothing but "something went wrong" costs a round trip
    // through the server logs to learn anything at all.
    const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).pop() : null;
    res.status(500).json({ error: reason ?? "Could not work out the numbers" });
  }
});

export default router;
