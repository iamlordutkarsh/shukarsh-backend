import { Router, type NextFunction, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { serializeProduct, serializeProducts } from "../lib/product";
import {
  LOW_STOCK_DEFAULT,
  NotEnoughStockError,
  moveStock,
  serializeStockMove,
} from "../lib/inventory";
import { AttributeError, attributeAnswerSchema, saveProductAttributes } from "../lib/attributes";
import { descendantIds } from "../lib/category";
import { ratingSummaries, ratingSummary } from "../lib/reviews";
import { GST_RATES, defaultGstRate } from "../lib/tax";
import { authenticate, isAdminRequest, requireAdmin } from "../middleware/auth";

const router = Router();

/** One row of the spec table: "Material", "Stainless steel". */
const specSchema = z.object({
  label: z.string().trim().min(1).max(40),
  value: z.string().trim().min(1).max(200),
});

/**
 * One block of the long copy.
 *
 * A discriminated union rather than one loose object, so a block cannot arrive
 * calling itself an FAQ while carrying a body: the product page switches on
 * `kind` to decide what to draw, and a shape it does not expect is a block that
 * renders as nothing at all.
 */
const detailBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4000),
  }),
  z.object({
    kind: z.literal("highlights"),
    title: z.string().trim().min(1).max(80),
    items: z.array(z.string().trim().min(1).max(200)).min(1).max(12),
  }),
  z.object({
    kind: z.literal("faq"),
    title: z.string().trim().min(1).max(80),
    items: z
      .array(
        z.object({
          question: z.string().trim().min(1).max(200),
          answer: z.string().trim().min(1).max(2000),
        })
      )
      .min(1)
      .max(12),
  }),
]);

const productSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  comparePrice: z.number().positive().optional(),
  stock: z.number().int().min(0).default(0),
  lowStockThreshold: z.number().int().min(0).max(1000).default(LOW_STOCK_DEFAULT),
  images: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  weightKg: z.number().positive().max(50).default(0.5),
  lengthCm: z.number().int().positive().max(200).default(15),
  breadthCm: z.number().int().positive().max(200).default(12),
  heightCm: z.number().int().positive().max(200).default(6),
  hsn: z
    .string()
    .trim()
    .max(10)
    .optional()
    .transform((value) => value || null),
  // Left optional so the create handler can fall back to GST_DEFAULT_RATE at
  // request time. A zod .default() would read the env at import, which happens
  // before dotenv has run.
  gstRate: z
    .number()
    .refine((value) => GST_RATES.includes(value as (typeof GST_RATES)[number]), {
      message: `GST rate must be one of ${GST_RATES.join(", ")}`,
    })
    .optional(),
  // Net of GST: input tax credit means the tax paid to a supplier is not a cost.
  costPrice: z.number().min(0).nullable().optional(),
  specs: z.array(specSchema).max(30).optional(),
  details: z.array(detailBlockSchema).max(12).optional(),
  // Required on the label of anything packaged and sold online in India. Held
  // loosely here and enforced by the category's own questions where a shop wants
  // it mandatory: the catalogue predates these, and a save that suddenly refuses
  // every existing product helps nobody.
  countryOfOrigin: z.string().trim().max(60).optional().nullable(),
  manufacturerName: z.string().trim().max(120).optional().nullable(),
  manufacturerAddr: z.string().trim().max(300).optional().nullable(),
  manufacturerPin: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "A pincode is six digits")
    .optional()
    .nullable()
    .or(z.literal("")),
  /** Answers to the category's questions, keyed by the definition's key. */
  attributes: z.array(attributeAnswerSchema).max(60).optional(),
  categoryId: z.string().min(1),
});

const stockAdjustSchema = z.object({
  /** Signed and never zero: this endpoint states a movement, not a total. */
  delta: z.number().int().min(-10000).max(10000).refine((value) => value !== 0, {
    message: "Say how many units to add or take away",
  }),
  reason: z.enum(["RECEIVED", "CORRECTION", "DAMAGE"]),
  note: z.string().trim().max(200).optional(),
  /** Which colour and size received them. Required once a product has options. */
  variantId: z.string().uuid().optional(),
});

/** Thrown inside the transaction so the whole adjustment rolls back with it. */
class VariantRequiredError extends Error {}
class UnknownVariantError extends Error {}

const variantsSchema = z.object({
  /**
   * The colours, in swatch order. Sent whole for the same reason the cells are.
   */
  colours: z
    .array(
      z.object({
        /** Absent creates it. Present must already belong to this product. */
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(40),
        /** `#rrggbb`, or nothing for a colour that has no sensible hex. */
        hex: z
          .string()
          .trim()
          .regex(/^#[0-9a-fA-F]{6}$/, "A colour has to be a hex code like #1a2b3c")
          .optional()
          .nullable(),
        images: z.array(z.string()).max(8).default([]),
        isActive: z.boolean().default(true),
      })
    )
    .max(20)
    .default([]),
  /**
   * The whole set of buyable cells, in the order they should appear. Sent
   * complete rather than one at a time because "S, M, L in red and blue" is one
   * decision, and half of it applied is a product selling combinations nobody
   * chose.
   */
  variants: z
    .array(
      z.object({
        /** Absent creates it. Present must already belong to this product. */
        id: z.string().uuid().optional(),
        /**
         * Which colour this cell is, named rather than referenced: the admin
         * screen builds the matrix before the new colours have ids, so the
         * payload has to be able to point at one it is creating in the same
         * breath. Matched against `colours` above, case-insensitively.
         */
        colourName: z.string().trim().max(40).optional().nullable(),
        /** Empty for a product sold by colour alone. */
        label: z.string().trim().max(24).default(""),
        /**
         * What this cell costs, when it differs from the product. Null clears an
         * override back to the product's own price, which is why it is nullable
         * rather than merely optional: "leave it alone" and "it costs the normal
         * amount again" are different instructions.
         */
        price: z.number().positive().nullable().optional(),
        isActive: z.boolean().default(true),
      })
    )
    .max(200),
});

/** A cell has to be one of something. Neither axis named is not a variant. */
class NamelessVariantError extends Error {}
/** A cell pointing at a colour that is not in the same payload. */
class UnknownColourError extends Error {}

/**
 * Everything serializeProduct needs, in the order things are drawn.
 *
 * Hoisted because five reads want it and a sixth that forgets the colours would
 * quietly serve a product with no swatches rather than fail: the serializer
 * cannot tell a product that has none from a query that did not ask.
 */
const productInclude: Prisma.ProductInclude = {
  category: { select: { id: true, name: true, slug: true } },
  variants: { orderBy: [{ position: "asc" }, { label: "asc" }] },
  colours: { orderBy: [{ position: "asc" }, { name: "asc" }] },
  attributes: { include: { definition: true, option: true } },
};

const sortOptions = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  "price-asc": { price: "asc" },
  "price-desc": { price: "desc" },
  name: { name: "asc" },
} as const;

type SortKey = keyof typeof sortOptions;

/**
 * These reads answer differently for an admin, who gets costPrice back. The only
 * thing telling the two bodies apart is a request header, so the response has to
 * say so: a CDN or proxy keying on the URL alone would otherwise be free to
 * store an admin's answer and serve supplier costs to shoppers.
 */
function perCaller(_req: Request, res: Response, next: NextFunction) {
  res.vary("Authorization");
  res.setHeader("Cache-Control", "private, no-store");
  next();
}

router.get("/", perCaller, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
  const categoryId = req.query.categoryId as string | undefined;
  const search = req.query.search as string | undefined;
  const sortKey = req.query.sort as SortKey | undefined;
  const orderBy = sortKey && sortKey in sortOptions ? sortOptions[sortKey] : sortOptions.newest;

  const where: any = { isActive: true };
  // Everything at or below the category asked for. Matching it exactly empties
  // every page above the leaves: a shirt filed under Tshirts would show nothing
  // on Men Fashion, which is the page the menu actually links to.
  if (categoryId) where.categoryId = { in: await descendantIds(categoryId) };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy,
      include: productInclude,
    }),
    prisma.product.count({ where }),
  ]);

  // One grouped query for the whole page, after the page is known. Asking per
  // card would be twelve round trips, and this database is behind a pooler that
  // has already been exhausted once by a fan of concurrent reads.
  const ratings = await ratingSummaries(products.map((product) => product.id));

  res.json({
    // The admin catalogue reads this same endpoint, so cost comes back for an
    // admin and is dropped for everyone else.
    products: serializeProducts(products, {
      includeCost: isAdminRequest(req),
      includeHidden: isAdminRequest(req),
      ratings,
    }),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

router.get("/:slug", perCaller, async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug as string },
    include: productInclude,
  });

  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const rating = await ratingSummary(product.id);

  res.json({
    product: serializeProduct(product, {
      includeCost: isAdminRequest(req),
      includeHidden: isAdminRequest(req),
      rating,
    }),
  });
});

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  try {
    const opening = result.data.stock;
    const { attributes, ...fields } = result.data;

    const product = await prisma.$transaction(async (tx) => {
      // Created empty and then filled through the ledger, so the number on the
      // shelf is the sum of its movements from the very first one. A product that
      // starts at 12 with nothing to say why is exactly the gap this closes.
      const created = await tx.product.create({
        data: { ...fields, stock: 0, gstRate: fields.gstRate ?? defaultGstRate() },
      });

      await saveProductAttributes(tx, created.id, created.categoryId, attributes ?? []);

      if (opening > 0) {
        await moveStock(tx, {
          productId: created.id,
          delta: opening,
          reason: "INITIAL",
          userId: req.user!.id,
        });
      }

      return tx.product.findUnique({ where: { id: created.id }, include: productInclude });
    });

    res.status(201).json({ product: serializeProduct(product, { includeCost: true }) });
  } catch (error) {
    if (error instanceof AttributeError) {
      res.status(400).json({ error: error.message });
      return;
    }

    handleWriteError(res, error, {
      duplicate: "A product already uses that slug",
      related: "That category does not exist",
      fallback: "Could not create this product",
    });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const result = productSchema.partial().safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const id = req.params.id as string;
  // Handled separately below: writing it straight would move the shelf with no
  // record of why, which is the one thing the ledger exists to prevent.
  const { stock: wantedStock, attributes, ...fields } = result.data;

  try {
    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id }, data: fields });

      // Re-checked against whichever category the product is in *after* this
      // save, so moving it to a category that asks more questions is refused
      // here rather than leaving it filed somewhere it cannot satisfy.
      if (attributes) {
        await saveProductAttributes(tx, id, updated.categoryId, attributes);
      }

      if (wantedStock !== undefined && wantedStock !== updated.stock) {
        // A form posts where the count should end up, not by how much it moved,
        // so the difference is worked out here and recorded as a correction.
        await moveStock(tx, {
          productId: id,
          delta: wantedStock - updated.stock,
          reason: "CORRECTION",
          note: "Set from the product form",
          userId: req.user!.id,
          allowNegative: true,
        });
      }

      return tx.product.findUnique({ where: { id }, include: productInclude });
    });

    res.json({ product: serializeProduct(product, { includeCost: true }) });
  } catch (error) {
    if (error instanceof AttributeError) {
      res.status(400).json({ error: error.message });
      return;
    }

    handleWriteError(res, error, {
      missing: "Product not found",
      duplicate: "Another product already uses that slug",
      related: "That category does not exist",
      fallback: "Could not save this product",
    });
  }
});

/**
 * Moves stock by a difference rather than to a total.
 *
 * Two people receiving stock at once both add what they added. A form that posts
 * the total silently discards whichever save lands second, along with the sale
 * that happened in between.
 */
router.post("/:id/stock", authenticate, requireAdmin, async (req, res) => {
  const result = stockAdjustSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const id = req.params.id as string;

  try {
    const product = await prisma.$transaction(async (tx) => {
      // Which row holds this product's stock. Once it has options the total is
      // only their sum, so an adjustment that does not name one has nowhere to
      // land. A cell under a switched-off colour is not one of them: its stock is
      // withdrawn along with the colour, and receiving against it would put units
      // somewhere nobody can sell them from.
      const cells = await tx.productVariant.findMany({
        where: { productId: id, isActive: true, OR: [{ colourId: null }, { colour: { isActive: true } }] },
        select: { id: true },
      });

      if (cells.length > 0) {
        if (!result.data.variantId) throw new VariantRequiredError();
        if (!cells.some((cell) => cell.id === result.data.variantId)) throw new UnknownVariantError();
      }

      const balance = await moveStock(tx, {
        productId: id,
        variantId: cells.length > 0 ? result.data.variantId : null,
        delta: result.data.delta,
        reason: result.data.reason,
        note: result.data.note,
        userId: req.user!.id,
        // A recount says what is really there, so it is allowed to contradict us.
        allowNegative: result.data.reason === "CORRECTION",
      });

      const updated = await tx.product.findUnique({
        where: { id },
        include: productInclude,
      });

      return { updated, balance };
    });

    if (!product.updated) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({
      product: serializeProduct(product.updated, { includeCost: true, includeHidden: true }),
    });
  } catch (error) {
    if (error instanceof VariantRequiredError) {
      res.status(400).json({ error: "This product comes in options, so say which one this is for." });
      return;
    }

    if (error instanceof UnknownVariantError) {
      res.status(400).json({ error: "That option does not belong to this product." });
      return;
    }

    if (error instanceof NotEnoughStockError) {
      res.status(409).json({ error: "There are not that many on the shelf to take away." });
      return;
    }

    handleWriteError(res, error, {
      missing: "Product not found",
      fallback: "Could not adjust the stock",
    });
  }
});

/**
 * Sets the whole set of colours and sizes a product comes in.
 *
 * Sent as one set rather than one at a time, because "S, M, L in red and blue"
 * is a single decision and half of it applied is a product selling combinations
 * nobody chose.
 *
 * One that disappears from the set is switched off rather than deleted, as
 * soon as it has any history: its stock ledger and the orders that name it have
 * to survive. Only one that never moved and never sold is actually removed,
 * which is what makes correcting a typo possible.
 *
 * Colours are saved in the same request and written first, so a cell may name a
 * colour this very payload is creating. The alternative is two round trips with
 * a product that sells nothing in between.
 */
router.put("/:id/variants", authenticate, requireAdmin, async (req, res) => {
  const result = variantsSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const id = req.params.id as string;
  const wanted = result.data.variants;
  const wantedColours = result.data.colours;

  const colourNames = wantedColours.map((colour) => colour.name.toLowerCase());
  if (new Set(colourNames).size !== colourNames.length) {
    res.status(400).json({ error: "Two colours cannot have the same name." });
    return;
  }

  // The database can only enforce this on a product that has colours, because
  // two nulls do not collide in a unique index. Checked here for every shape,
  // and case-insensitively, so "M" beside "m" is refused as well.
  const cells = wanted.map(
    (variant) => `${variant.colourName?.trim().toLowerCase() ?? ""}::${variant.label.toLowerCase()}`
  );
  if (new Set(cells).size !== cells.length) {
    res.status(400).json({ error: "Two options cannot be the same colour and size." });
    return;
  }

  try {
    const product = await prisma.$transaction(async (tx) => {
      const [existing, existingColours] = await Promise.all([
        tx.productVariant.findMany({ where: { productId: id } }),
        tx.productColour.findMany({ where: { productId: id } }),
      ]);

      const nothingBefore = existing.length === 0 && existingColours.length === 0;
      const nothingAfter = wanted.length === 0 && wantedColours.length === 0;
      if (nothingBefore && nothingAfter) {
        return tx.product.findUnique({ where: { id }, include: productInclude });
      }

      /**
       * Colours first, so the cells below have something to point at.
       *
       * A colour that disappears is dropped only when nothing under it ever
       * moved or sold; otherwise it is switched off, which switches off its
       * cells with it. Deleting it would cascade the variants away and take
       * their ledger with them.
       */
      const keptColourIds = new Set(
        wantedColours.map((colour) => colour.id).filter(Boolean) as string[]
      );

      for (const gone of existingColours.filter((colour) => !keptColourIds.has(colour.id))) {
        const [moves, sold] = await Promise.all([
          tx.stockMove.count({ where: { variant: { colourId: gone.id } } }),
          tx.orderItem.count({ where: { variant: { colourId: gone.id } } }),
        ]);

        if (moves === 0 && sold === 0) {
          await tx.productColour.delete({ where: { id: gone.id } });
        } else {
          await tx.productColour.update({ where: { id: gone.id }, data: { isActive: false } });
          await tx.productVariant.updateMany({
            where: { colourId: gone.id },
            data: { isActive: false },
          });
        }
      }

      /** Name to id, so a cell can name a colour being created in this request. */
      const colourIdByName = new Map<string, string>();

      for (const [position, colour] of wantedColours.entries()) {
        const data = {
          name: colour.name,
          hex: colour.hex ?? null,
          images: colour.images,
          isActive: colour.isActive,
          position,
        };

        const saved = colour.id
          ? await tx.productColour.update({ where: { id: colour.id }, data })
          : await tx.productColour.create({ data: { productId: id, ...data } });

        colourIdByName.set(colour.name.trim().toLowerCase(), saved.id);
      }

      const keptIds = new Set(wanted.map((variant) => variant.id).filter(Boolean) as string[]);

      for (const gone of existing.filter((variant) => !keptIds.has(variant.id))) {
        const [moves, sold] = await Promise.all([
          tx.stockMove.count({ where: { variantId: gone.id } }),
          tx.orderItem.count({ where: { variantId: gone.id } }),
        ]);

        if (moves === 0 && sold === 0) {
          await tx.productVariant.delete({ where: { id: gone.id } });
        } else {
          await tx.productVariant.update({ where: { id: gone.id }, data: { isActive: false } });
        }
      }

      for (const [position, variant] of wanted.entries()) {
        const wantsColour = variant.colourName?.trim();
        const colourId = wantsColour ? colourIdByName.get(wantsColour.toLowerCase()) : null;

        // A cell naming a colour the payload did not send would silently become
        // a colourless one, which on a product that has colours is a second
        // shelf nobody can see or pick.
        if (wantsColour && !colourId) throw new UnknownColourError(wantsColour);
        if (!colourId && !variant.label) throw new NamelessVariantError();

        const data = {
          colourId: colourId ?? null,
          label: variant.label,
          // Undefined leaves an override alone; null clears it back to the
          // product's price. zod keeps the two apart, so this does too.
          ...(variant.price !== undefined ? { price: variant.price } : {}),
          isActive: variant.isActive,
          position,
        };

        if (variant.id) {
          await tx.productVariant.update({ where: { id: variant.id }, data });
        } else {
          await tx.productVariant.create({ data: { productId: id, ...data } });
        }
      }

      // The moment cells exist they own the stock, and nobody can say how many of
      // that shelf of 41 jackets were blue mediums. Rather than guess, the total
      // is written down to zero through the ledger so the shop counts each in.
      const current = await tx.product.findUnique({ where: { id }, select: { stock: true } });
      if (existing.length === 0 && wanted.length > 0 && (current?.stock ?? 0) !== 0) {
        await moveStock(tx, {
          productId: id,
          delta: -(current?.stock ?? 0),
          reason: "CORRECTION",
          note: "Split into options: count each one in",
          userId: req.user!.id,
          allowNegative: true,
        });
      }

      return tx.product.findUnique({ where: { id }, include: productInclude });
    });

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ product: serializeProduct(product, { includeCost: true, includeHidden: true }) });
  } catch (error) {
    if (error instanceof UnknownColourError) {
      res.status(400).json({ error: `No colour called "${error.message}" was sent with these options.` });
      return;
    }

    if (error instanceof NamelessVariantError) {
      res.status(400).json({ error: "An option needs a colour, a size, or both." });
      return;
    }

    handleWriteError(res, error, {
      missing: "Product not found",
      duplicate: "This product already has an option with that colour and size",
      fallback: "Could not save these options",
    });
  }
});

/** Where the stock went, newest first. */
router.get("/:id/stock-moves", authenticate, requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));

  const moves = await prisma.stockMove.findMany({
    where: { productId: req.params.id as string },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { firstName: true, lastName: true } } },
  });

  res.json({ moves: moves.map(serializeStockMove) });
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = req.params.id as string;

  try {
    await prisma.product.delete({ where: { id } });
    res.json({ message: "Product deleted" });
  } catch (error) {
    handleWriteError(res, error, {
      missing: "Product not found",
      // OrderItem points here so an invoice can still name what was bought, and
      // the database will not let that history be broken. Switching the product
      // off is the way to retire it.
      related: "This product has orders against it. Switch it off instead of deleting it.",
      fallback: "Could not delete this product",
    });
  }
});

export default router;
