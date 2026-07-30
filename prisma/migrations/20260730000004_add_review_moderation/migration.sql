-- Review has existed since the first migration but nothing has ever written to
-- it, so there are no rows to think about here. Every column added is nullable
-- regardless, because this runs against production before the new code deploys.

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "hiddenReason" TEXT;

-- CreateIndex
-- Every public listing is "reviews for this product that are not hidden".
CREATE INDEX "Review_productId_hiddenAt_idx" ON "Review"("productId", "hiddenAt");

-- AddForeignKey
-- SET NULL, not CASCADE: deleting an order must not silently delete the
-- customer's published opinion of the product.
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
