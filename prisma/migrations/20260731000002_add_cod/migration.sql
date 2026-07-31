CREATE TYPE "PaymentMethod" AS ENUM ('PREPAID', 'COD');

-- Every existing order was paid through Razorpay, so the default backfills them
-- correctly and no data migration is needed.
ALTER TABLE "Order" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'PREPAID';
ALTER TABLE "Order" ADD COLUMN "codFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
