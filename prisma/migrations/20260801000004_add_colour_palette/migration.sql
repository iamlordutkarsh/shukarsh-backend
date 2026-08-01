-- The second half of a two-tone swatch, for a print or a stripe that no single
-- colour describes. Null is the ordinary case and draws a plain circle.
ALTER TABLE "ProductColour" ADD COLUMN "hex2" TEXT;

-- The shop's own list of colours, reused across products.
--
-- Free text drifts: one product says "Navy", the next "navy blue", the third
-- "Dark Blue", and they become three colours with three sets of photos that no
-- filter can bring together. Picking from a list at the point of typing is what
-- stops that.
--
-- Deliberately not referenced by ProductColour. A product's colour keeps owning
-- its own name, hex and photos, so retiring a preset cannot repaint products
-- already using it, and a one-off colour is still possible.
CREATE TABLE "ColourPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT,
    "hex2" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColourPreset_pkey" PRIMARY KEY ("id")
);

-- One row per name, which is the whole point of having a list.
CREATE UNIQUE INDEX "ColourPreset_name_key" ON "ColourPreset"("name");
