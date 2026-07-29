-- CreateEnum
CREATE TYPE "StockMoveReason" AS ENUM ('INITIAL', 'SALE', 'CANCELLATION', 'REOPEN', 'RETURN_RESTOCK', 'RECEIVED', 'CORRECTION', 'DAMAGE');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lowStockThreshold" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "StockMove" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "reason" "StockMoveReason" NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemFlag" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemFlag_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "StockMove_productId_createdAt_idx" ON "StockMove"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMove_createdAt_idx" ON "StockMove"("createdAt");

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Opening balance for everything already on the shelf. Without it every existing
-- product reads as unexplained stock, and the drift check has nothing to compare
-- against. This invents no history: it records where the counting started.
INSERT INTO "StockMove" ("id", "productId", "delta", "balance", "reason", "note", "createdAt")
SELECT gen_random_uuid(), "id", "stock", "stock", 'INITIAL', 'Opening balance when stock history began', NOW()
FROM "Product"
WHERE "stock" <> 0;