/**
 * Sends an async handler's rejection to the error middleware below.
 *
 * Express 4 only catches what a handler throws synchronously; a rejected promise
 * escapes it entirely. That took the whole service down once — Node exits on an
 * unhandled rejection — and after that was guarded it left the request hanging
 * instead. This is imported first, before any route is defined, because it works
 * by patching the router.
 */
import "express-async-errors";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth";
import categoryRoutes from "./routes/categories";
import colourRoutes from "./routes/colours";
import productRoutes from "./routes/products";
import orderRoutes from "./routes/orders";
import newsletterRoutes from "./routes/newsletter";
import uploadRoutes from "./routes/uploads";
import wishlistRoutes from "./routes/wishlist";
import addressRoutes from "./routes/addresses";
import logisticsRoutes from "./routes/logistics";
import couponRoutes from "./routes/coupons";
import returnRoutes from "./routes/returns";
import reviewRoutes from "./routes/reviews";
import analyticsRoutes from "./routes/analytics";

dotenv.config();

const app = express();

// Render terminates TLS in front of us, so the client IP is only in the
// forwarded header. Rate limiting buckets by IP and would otherwise see one.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  })
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      // Webhook signatures cover the bytes as sent, not a re-serialized object.
      (req as express.Request).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.json({ message: "Shukarsh API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/colours", colourRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/logistics", logisticsRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  // The path is worth logging: this now catches async rejections too, and
  // "Something went wrong" with no route attached is not a lead.
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
