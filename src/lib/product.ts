import { serializeProductAttributes, type SerializedProductAttribute } from "./attributes";
import { LOW_STOCK_DEFAULT } from "./inventory";
import { EMPTY_RATING, type RatingSummary } from "./reviews";

export interface SerializedProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  comparePrice: number | null;
  stock: number;
  lowStockThreshold: number;
  images: string[];
  isActive: boolean;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  hsn: string | null;
  gstRate: number;
  countryOfOrigin: string | null;
  manufacturerName: string | null;
  manufacturerAddr: string | null;
  manufacturerPin: string | null;
  /**
   * What this product answered to its category's questions, in the order the
   * category asks them. Structured, filterable, and the reason a spec table can
   * be consistent across a catalogue rather than however each admin typed it.
   */
  attributes: SerializedProductAttribute[];
  /** The spec table, in the order the shop typed it. Empty when none was given. */
  specs: ProductSpec[];
  /** The long copy, as blocks. Empty when none was given. */
  details: DetailBlock[];
  /** Admin responses only. Never present on a public one. */
  costPrice?: number | null;
  /**
   * Absent means "this response did not count them", which is not the same as
   * zero reviews. Only the shopper-facing reads pay for the aggregate; a stock
   * adjustment has no business running a second query to answer a question
   * nobody asked, and a hardcoded zero there would read as "nobody likes this".
   */
  rating?: RatingSummary;
  /**
   * The buyable cells, when a product has any. An empty array means it sells as
   * one thing, which is the case for most of the catalogue, so a storefront can
   * ask `variants.length > 0` rather than knowing which products are clothes.
   */
  variants: SerializedVariant[];
  /**
   * The colours, when a product comes in any. Separate from the variants because
   * a swatch row is drawn once whatever the sizes are, and because the photos
   * hang here rather than on each cell.
   */
  colours: SerializedColour[];
  /**
   * The cheapest and dearest a shopper can actually pay, once the cells that
   * override the price are taken into account. Equal to `price` on both sides
   * for the ordinary product, so a card can compare the two and only say "from"
   * when they differ.
   */
  priceFrom: number;
  priceTo: number;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slug: string };
}

export interface ProductSpec {
  label: string;
  value: string;
}

/** A block of the long copy. `kind` says which of the three shapes it is. */
export type DetailBlock =
  | { kind: "text"; title: string; body: string }
  | { kind: "highlights"; title: string; items: string[] }
  | { kind: "faq"; title: string; items: { question: string; answer: string }[] };

export interface SerializedVariant {
  id: string;
  label: string;
  /** Null on a product sold in sizes only. */
  colourId: string | null;
  stock: number;
  position: number;
  isActive: boolean;
  /**
   * What this cell costs. Always a number, already resolved against the
   * product's own price, so nothing reading it has to know that an override was
   * involved. `hasOwnPrice` says whether one was, for the admin screen that
   * edits it.
   */
  price: number;
  hasOwnPrice: boolean;
}

export interface SerializedColour {
  id: string;
  name: string;
  hex: string | null;
  images: string[];
  position: number;
  isActive: boolean;
}

/** What one cell actually costs: its own price where it has one, else the product's. */
export function variantPrice(variant: { price?: unknown }, basePrice: number): number {
  return variant.price != null ? Number(variant.price) : basePrice;
}

/**
 * The range a shopper can actually pay.
 *
 * Only sellable cells count. A withdrawn XXL that cost double would otherwise
 * keep widening the range on a card, and "from ₹400 to ₹900" would be quoting a
 * price nobody can reach. A product whose cells all sell at the product price
 * comes back with both ends equal, which is what lets a card decide whether to
 * write "from" at all.
 */
export function priceSpread(
  basePrice: number,
  variants: { price?: unknown; isActive?: boolean }[]
): { priceFrom: number; priceTo: number } {
  const sellable = variants.filter((variant) => variant.isActive !== false);
  if (sellable.length === 0) return { priceFrom: basePrice, priceTo: basePrice };

  const prices = sellable.map((variant) => variantPrice(variant, basePrice));
  return { priceFrom: Math.min(...prices), priceTo: Math.max(...prices) };
}

/**
 * Reads the spec table back out of its column.
 *
 * Written through a zod schema, so anything in there was valid when it went in.
 * Checked again anyway because the column is JSON and a hand-edited row, a
 * restored backup or an older shape would otherwise reach a page as something it
 * cannot render. A bad entry is dropped rather than thrown on: a malformed spec
 * is no reason to fail the whole product page.
 */
export function readSpecs(raw: unknown): ProductSpec[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { label, value } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof value !== "string") return [];
    if (!label.trim() || !value.trim()) return [];
    return [{ label, value }];
  });
}

/** The same, for the long copy. Each block is kept only if its shape is intact. */
export function readDetails(raw: unknown): DetailBlock[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): DetailBlock[] => {
    if (!entry || typeof entry !== "object") return [];
    const block = entry as Record<string, unknown>;
    const title = typeof block.title === "string" ? block.title : "";
    if (!title.trim()) return [];

    if (block.kind === "text") {
      return typeof block.body === "string" && block.body.trim()
        ? [{ kind: "text" as const, title, body: block.body }]
        : [];
    }

    if (block.kind === "highlights") {
      const items = Array.isArray(block.items)
        ? block.items.filter((item): item is string => typeof item === "string" && !!item.trim())
        : [];
      return items.length > 0 ? [{ kind: "highlights" as const, title, items }] : [];
    }

    if (block.kind === "faq") {
      const items = Array.isArray(block.items)
        ? block.items.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const { question, answer } = item as Record<string, unknown>;
            if (typeof question !== "string" || typeof answer !== "string") return [];
            if (!question.trim() || !answer.trim()) return [];
            return [{ question, answer }];
          })
        : [];
      return items.length > 0 ? [{ kind: "faq" as const, title, items }] : [];
    }

    return [];
  });
}

/**
 * Turns a product row into something safe to send out.
 *
 * The catalogue endpoints are public, so this names the fields that may leave
 * rather than the ones that may not. Naming what to strip means a new private
 * column ships to the storefront until someone remembers to add it to the list,
 * and a relation nobody thought of goes out whole. Cost price stays opt-in: a
 * caller that forgets the flag shows a shopper too little, not too much.
 */
export function serializeProduct(
  product: any,
  options?: { includeCost?: boolean; includeHidden?: boolean; rating?: RatingSummary }
): SerializedProduct {
  const basePrice = Number(product.price);

  const serialized: SerializedProduct = {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price: Number(product.price),
    comparePrice: product.comparePrice != null ? Number(product.comparePrice) : null,
    stock: product.stock,
    lowStockThreshold: product.lowStockThreshold ?? LOW_STOCK_DEFAULT,
    images: product.images,
    isActive: product.isActive,
    weightKg: Number(product.weightKg),
    lengthCm: product.lengthCm,
    breadthCm: product.breadthCm,
    heightCm: product.heightCm,
    hsn: product.hsn,
    gstRate: Number(product.gstRate ?? 0),
    countryOfOrigin: product.countryOfOrigin ?? null,
    manufacturerName: product.manufacturerName ?? null,
    manufacturerAddr: product.manufacturerAddr ?? null,
    manufacturerPin: product.manufacturerPin ?? null,
    attributes: serializeProductAttributes(product.attributes ?? []),
    specs: readSpecs(product.specs),
    details: readDetails(product.details),
    // A read that did not ask for them says "no variants" rather than nothing, so
    // a caller never has to tell a product without them apart from a query that
    // forgot to include them. Withdrawn cells are left out of every response but
    // the admin one, which needs to see what it can switch back on.
    variants: ((product.variants ?? []) as any[])
      .filter((variant) => options?.includeHidden || variant.isActive)
      .map((variant) => ({
        id: variant.id,
        label: variant.label,
        colourId: variant.colourId ?? null,
        stock: variant.stock,
        position: variant.position,
        isActive: variant.isActive,
        price: variantPrice(variant, basePrice),
        hasOwnPrice: variant.price != null,
      })),
    colours: ((product.colours ?? []) as any[])
      .filter((colour) => options?.includeHidden || colour.isActive)
      .map((colour) => ({
        id: colour.id,
        name: colour.name,
        hex: colour.hex ?? null,
        images: colour.images ?? [],
        position: colour.position,
        isActive: colour.isActive,
      })),
    ...priceSpread(basePrice, (product.variants ?? []) as any[]),
    categoryId: product.categoryId,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };

  if (product.category) {
    serialized.category = {
      id: product.category.id,
      name: product.category.name,
      slug: product.category.slug,
    };
  }

  if (options?.includeCost) {
    serialized.costPrice = product.costPrice != null ? Number(product.costPrice) : null;
  }

  if (options?.rating) {
    serialized.rating = options.rating;
  }

  return serialized;
}

export function serializeProducts(
  products: any[],
  options?: { includeCost?: boolean; includeHidden?: boolean; ratings?: Map<string, RatingSummary> }
): SerializedProduct[] {
  return products.map((product) =>
    serializeProduct(product, {
      includeCost: options?.includeCost,
      includeHidden: options?.includeHidden,
      // Products nobody has reviewed are missing from the grouped result, so an
      // absent key is a real zero here rather than an unanswered question.
      rating: options?.ratings ? (options.ratings.get(product.id) ?? EMPTY_RATING) : undefined,
    })
  );
}
