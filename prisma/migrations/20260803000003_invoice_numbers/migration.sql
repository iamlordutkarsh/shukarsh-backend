-- Tax invoice numbering.
--
-- Rule 46 of the CGST Rules wants a consecutive serial number, at most sixteen
-- characters, unique within a financial year. The order's uuid is neither
-- consecutive nor short enough, so a real series is needed.
--
-- Nullable because every order placed before this migration has no number and
-- must not acquire one retrospectively: renumbering an order that has already
-- shipped would put a different number on the reissued invoice to the one in
-- the customer's parcel.
ALTER TABLE "Order" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "invoicedAt" TIMESTAMP(3);

-- Unique so a duplicate cannot be written even if the counter is ever wrong.
-- A partial index would suit the nulls better, but Prisma models this as a
-- plain unique and Postgres already allows repeated nulls in one.
CREATE UNIQUE INDEX "Order_invoiceNumber_key" ON "Order"("invoiceNumber");

-- One row per financial year, holding the highest number handed out.
--
-- A table rather than counting existing invoices, because a count is not safe
-- under concurrency: two payments landing together would read the same total
-- and claim the same number, and there is no way to correct a duplicate after
-- it has been printed and put in a parcel. Incrementing a locked row is safe.
CREATE TABLE "InvoiceCounter" (
    "series" TEXT NOT NULL,
    "lastUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("series")
);
