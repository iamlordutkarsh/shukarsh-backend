-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "refundError" TEXT,
ADD COLUMN     "refundId" TEXT,
ADD COLUMN     "refundStatus" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_refundId_key" ON "ReturnRequest"("refundId");
