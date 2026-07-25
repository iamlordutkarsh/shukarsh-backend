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
  };
}

export function serializeProducts(products: any[]): SerializedProduct[] {
  return products.map(serializeProduct);
}
