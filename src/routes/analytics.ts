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
    res.status(500).json({ error: "Could not work out the numbers" });
  }
});

export default router;
