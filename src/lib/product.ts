import { LOW_STOCK_DEFAULT } from "./inventory";

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
export function serializeProduct(product: any, options?: { includeCost?: boolean }): SerializedProduct {
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

  return serialized;
}

export function serializeProducts(
  products: any[],
  options?: { includeCost?: boolean }
): SerializedProduct[] {
  return products.map((product) => serializeProduct(product, options));
}
