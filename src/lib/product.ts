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
  /** Admin responses only. Never present on a public one. */
  costPrice?: number | null;
  /**
   * Absent means "this response did not count them", which is not the same as
   * zero reviews. Only the shopper-facing reads pay for the aggregate; a stock
   * adjustment has no business running a second query to answer a question
   * nobody asked, and a hardcoded zero there would read as "nobody likes this".
   */
  rating?: RatingSummary;
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slug: string };
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
  options?: { includeCost?: boolean; rating?: RatingSummary }
): SerializedProduct {
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
  options?: { includeCost?: boolean; ratings?: Map<string, RatingSummary> }
): SerializedProduct[] {
  return products.map((product) =>
    serializeProduct(product, {
      includeCost: options?.includeCost,
      // Products nobody has reviewed are missing from the grouped result, so an
      // absent key is a real zero here rather than an unanswered question.
      rating: options?.ratings ? (options.ratings.get(product.id) ?? EMPTY_RATING) : undefined,
    })
  );
}
