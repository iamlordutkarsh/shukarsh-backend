import app from "./app";
import { startAbandonedOrderSweep } from "./lib/abandoned-orders";
import { startLowStockDigest } from "./lib/low-stock";
import { startTrackingSync } from "./lib/tracking-sync";

const PORT = process.env.PORT || 5000;

/**
 * A rejected promise nobody caught must not take the shop down with it.
 *
 * Express 4 does not catch an async handler that rejects, and Node exits on an
 * unhandled rejection by default. A database hiccup on one request restarted the
 * whole service, dropping every other request in flight with it.
 *
 * This is a backstop, not a fix: the request that caused it still hangs until it
 * times out, so the handler that let it escape is still worth finding. Logged
 * loudly for exactly that reason.
 */
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection — a route is missing its error handling:", reason);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startTrackingSync();
  startAbandonedOrderSweep();
  startLowStockDigest();
});
