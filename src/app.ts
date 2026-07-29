import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth";
import categoryRoutes from "./routes/categories";
import productRoutes from "./routes/products";
import orderRoutes from "./routes/orders";
import newsletterRoutes from "./routes/newsletter";
import uploadRoutes from "./routes/uploads";
import wishlistRoutes from "./routes/wishlist";
import logisticsRoutes from "./routes/logistics";
import couponRoutes from "./routes/coupons";
import returnRoutes from "./routes/returns";
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
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/logistics", logisticsRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
