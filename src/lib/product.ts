export interface SerializedProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  comparePrice: number | null;
  stock: number;
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
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slug: string };
}

/**
 * Turns a product row into something safe to send out.
 *
 * What this leaves out matters more than what it keeps. The catalogue
 * endpoints are public, so anything spread out of the row here is readable by
 * anyone who can reach the API. Cost price is therefore opt-in rather than
 * opt-out: a new private column added to the schema is dropped by default,
 * instead of quietly shipping to the storefront until someone notices.
 */
export function serializeProduct(product: any, options?: { includeCost?: boolean }): SerializedProduct {
  const {
    costPrice,
    // Relations the callers do not ask for are pulled out rather than spread.
    coupons,
    orderItems,
    cartItems,
    reviews,
    wishlisted,
    ...rest
  } = product;

  const serialized: SerializedProduct = {
    ...rest,
    price: Number(product.price),
    comparePrice: product.comparePrice != null ? Number(product.comparePrice) : null,
    weightKg: Number(product.weightKg),
    gstRate: Number(product.gstRate ?? 0),
  };

  if (options?.includeCost) {
    serialized.costPrice = costPrice != null ? Number(costPrice) : null;
  }

  return serialized;
}

export function serializeProducts(
  products: any[],
  options?: { includeCost?: boolean }
): SerializedProduct[] {
  return products.map((product) => serializeProduct(product, options));
}
