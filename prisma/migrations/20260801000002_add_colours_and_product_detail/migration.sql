-- A colour is its own table because it carries photos. A red shirt in five sizes
-- is one set of pictures, not five copies of it.
CREATE TABLE "ProductColour" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductColour_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductColour_productId_idx" ON "ProductColour"("productId");

-- One row per colour per product, so two "Midnight blue"s cannot end up holding
-- separate photos and separate sizes.
CREATE UNIQUE INDEX "ProductColour_productId_name_key" ON "ProductColour"("productId", "name");

ALTER TABLE "ProductColour" ADD CONSTRAINT "ProductColour_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable on purpose. Every existing variant is a size on a product that has no
-- colours, and must keep selling exactly as it did; nothing is backfilled,
-- because deciding that a shelf of mediums was always blue is not ours to make.
ALTER TABLE "ProductVariant" ADD COLUMN "colourId" TEXT;

-- Null is the normal case and means "the product's price". Only a size or colour
-- that genuinely costs more carries a number here.
ALTER TABLE "ProductVariant" ADD COLUMN "price" DECIMAL(10,2);

CREATE INDEX "ProductVariant_colourId_idx" ON "ProductVariant"("colourId");

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_colourId_fkey"
    FOREIGN KEY ("colourId") REFERENCES "ProductColour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The key is the matrix cell now, not the size. Dropped and replaced rather than
-- added beside, because "M" has to be allowed once per colour: the old index
-- would refuse a blue medium on a product that already sells a red one.
--
-- This one cannot bind when colourId is null, since Postgres counts two nulls as
-- different values. The colourless case is guarded in the variants handler,
-- which compares labels case-insensitively and so catches "M" beside "m" too.
DROP INDEX "ProductVariant_productId_label_key";
CREATE UNIQUE INDEX "ProductVariant_productId_colourId_label_key"
    ON "ProductVariant"("productId", "colourId", "label");

-- The spec table and the long copy. JSON rather than tables of their own: nothing
-- queries them, they are only ever read whole and only ever on the product page,
-- and the catalogue list already carries two joins.
ALTER TABLE "Product" ADD COLUMN "specs" JSONB;
ALTER TABLE "Product" ADD COLUMN "details" JSONB;

-- Snapshot beside variantLabel, so a colour that is renamed or withdrawn cannot
-- rewrite an invoice that has already gone out.
ALTER TABLE "OrderItem" ADD COLUMN "variantColour" TEXT;
