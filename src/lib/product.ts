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
  categoryId: string;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slug: string };
}

export function serializeProduct(product: any): SerializedProduct {
  return {
    ...product,
    price: Number(product.price),
    comparePrice: product.comparePrice ? Number(product.comparePrice) : null,
    weightKg: Number(product.weightKg),
    gstRate: Number(product.gstRate ?? 0),
  };
}

export function serializeProducts(products: any[]): SerializedProduct[] {
  return products.map(serializeProduct);
}
