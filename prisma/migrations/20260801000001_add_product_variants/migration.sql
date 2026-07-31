CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- One row per size per product, so two "M"s cannot end up holding stock separately.
CREATE UNIQUE INDEX "ProductVariant_productId_label_key" ON "ProductVariant"("productId", "label");

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable on purpose. Existing products have no sizes and must keep selling from
-- Product.stock exactly as before, so nothing is backfilled here: splitting a
-- shelf of 120 t-shirts into sizes is a decision only the shop can make.
ALTER TABLE "StockMove" ADD COLUMN "variantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantLabel" TEXT;

CREATE INDEX "StockMove_variantId_idx" ON "StockMove"("variantId");
CREATE INDEX "OrderItem_variantId_idx" ON "OrderItem"("variantId");

ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not CASCADE: an order line keeps its variantLabel snapshot, and deleting a size
-- must never delete the record of what somebody bought.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
