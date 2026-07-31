-- A menu is not alphabetical: "Men Top Wear" comes before "Men Inner &
-- Sleepwear" because that is the order the shop sells in.
ALTER TABLE "Category" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- The hierarchy has been in the schema since the start and nothing walked it.
-- Reading a category's children is about to become the common case.
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- Required on the label of anything packaged and sold online in India. Columns
-- rather than attributes: a category nobody defined them on would silently drop
-- a legal requirement. Nullable, because the catalogue predates them and a
-- product cannot be made non-compliant retroactively by a migration.
ALTER TABLE "Product" ADD COLUMN "countryOfOrigin" TEXT;
ALTER TABLE "Product" ADD COLUMN "manufacturerName" TEXT;
ALTER TABLE "Product" ADD COLUMN "manufacturerAddr" TEXT;
ALTER TABLE "Product" ADD COLUMN "manufacturerPin" TEXT;

CREATE TYPE "AttributeKind" AS ENUM ('SELECT', 'MULTISELECT', 'TEXT', 'NUMBER');

-- One question a category asks about its products, inherited by everything under
-- it. This is what makes the tree worth having: "Country of origin" is asked once
-- at the root, "Sleeve length" only under Tshirts.
CREATE TABLE "AttributeDefinition" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "AttributeKind" NOT NULL DEFAULT 'SELECT',
    "unit" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttributeDefinition_categoryId_idx" ON "AttributeDefinition"("categoryId");

-- One question per key per category. The same key on a child is the override,
-- which is what lets a branch narrow a general question.
CREATE UNIQUE INDEX "AttributeDefinition_categoryId_key_key"
    ON "AttributeDefinition"("categoryId", "key");

ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A fixed list rather than free text is the point: "Cotton", "100% cotton" and
-- "cotton blend" typed into three products are three values nothing can filter on.
CREATE TABLE "AttributeOption" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributeOption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttributeOption_definitionId_idx" ON "AttributeOption"("definitionId");
CREATE UNIQUE INDEX "AttributeOption_definitionId_value_key"
    ON "AttributeOption"("definitionId", "value");

ALTER TABLE "AttributeOption" ADD CONSTRAINT "AttributeOption_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What one product answered. Exactly one value column is ever set, decided by the
-- definition's kind.
CREATE TABLE "ProductAttribute" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "optionId" TEXT,
    "valueText" TEXT,
    "valueNumber" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAttribute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductAttribute_productId_idx" ON "ProductAttribute"("productId");

-- The faceted read: every product whose answer to this question is that option.
CREATE INDEX "ProductAttribute_definitionId_optionId_idx"
    ON "ProductAttribute"("definitionId", "optionId");

-- Binds on the picked kinds. It cannot bind for TEXT or NUMBER, where optionId is
-- null and Postgres counts two nulls as different values, so the write path is
-- what stops a product answering the same question twice.
CREATE UNIQUE INDEX "ProductAttribute_productId_definitionId_optionId_key"
    ON "ProductAttribute"("productId", "definitionId", "optionId");

ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "AttributeOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
