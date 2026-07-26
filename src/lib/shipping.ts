import { prisma } from "./prisma";
import { computeParcel, createTtlCache, weightBucket, type Parcel } from "./parcel";
import {
  getServiceability,
  isShiprocketConfigured,
  pickupPincode,
  type CourierOption,
  type ServiceabilityResult,
} from "./shiprocket";

const RATE_TTL_SECONDS = Number(process.env.SHIPROCKET_RATE_CACHE_TTL_SEC) || 900;
const rateCache = createTtlCache<ServiceabilityResult>(RATE_TTL_SECONDS);

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface PricedLine {
  productId: string;
  name: string;
  slug: string;
  quantity: number;
  price: number;
  hsn: string | null;
}

export interface PricedCart {
  lines: PricedLine[];
  itemsTotal: number;
  parcel: Parcel;
}

/** Prices and weights always come from the database, never from the client. */
export async function priceCart(items: CartLine[]): Promise<PricedCart> {
  const ids = Array.from(new Set(items.map((item) => item.productId)));
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      stock: true,
      hsn: true,
      weightKg: true,
      lengthCm: true,
      breadthCm: true,
      heightCm: true,
    },
  });

  const byId = new Map(products.map((product) => [product.id, product]));
  const lines: PricedLine[] = [];
  const parcelItems = [];

  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) {
      throw Object.assign(new Error("A product in your bag is no longer available"), { statusCode: 400 });
    }
    if (product.stock < item.quantity) {
      throw Object.assign(new Error(`Only ${product.stock} left of ${product.name}`), { statusCode: 409 });
    }

    lines.push({
      productId: product.id,
      name: product.name,
      slug: product.slug,
      quantity: item.quantity,
      price: Number(product.price),
      hsn: product.hsn,
    });

    parcelItems.push({
      weightKg: Number(product.weightKg),
      lengthCm: product.lengthCm,
      breadthCm: product.breadthCm,
      heightCm: product.heightCm,
      quantity: item.quantity,
    });
  }

  const itemsTotal = lines.reduce((total, line) => total + line.price * line.quantity, 0);

  return { lines, itemsTotal, parcel: computeParcel(parcelItems) };
}

export async function quoteShipping(params: {
  pincode: string;
  parcel: Parcel;
  declaredValue: number;
}): Promise<ServiceabilityResult> {
  const key = `${pickupPincode()}|${params.pincode}|${weightBucket(params.parcel.weightKg)}`;
  const cached = rateCache.get(key);
  if (cached) return cached;

  const result = await getServiceability({
    deliveryPincode: params.pincode,
    weightKg: params.parcel.weightKg,
    declaredValue: params.declaredValue,
    lengthCm: params.parcel.lengthCm,
    breadthCm: params.parcel.breadthCm,
    heightCm: params.parcel.heightCm,
  });

  rateCache.set(key, result);
  return result;
}

export interface ResolvedShipping {
  amount: number;
  courierId: number | null;
  courierName: string | null;
  option: CourierOption | null;
  quoted: boolean;
}

/**
 * Resolves what to charge for shipping. Falls back to free shipping so the store
 * keeps taking orders when the courier account is unavailable.
 */
export async function resolveShipping(params: {
  pincode: string;
  parcel: Parcel;
  declaredValue: number;
  preferredCourierId?: number;
}): Promise<ResolvedShipping> {
  if (!isShiprocketConfigured() || !pickupPincode()) {
    return { amount: 0, courierId: null, courierName: null, option: null, quoted: false };
  }

  try {
    const { options } = await quoteShipping(params);
    if (options.length === 0) {
      return { amount: 0, courierId: null, courierName: null, option: null, quoted: false };
    }

    const chosen =
      (params.preferredCourierId && options.find((option) => option.courierId === params.preferredCourierId)) ||
      options.find((option) => option.recommended) ||
      options[0];

    return {
      amount: Math.round(chosen.rate),
      courierId: chosen.courierId,
      courierName: chosen.courierName,
      option: chosen,
      quoted: true,
    };
  } catch (error) {
    console.error("Shipping quote failed:", error);
    return { amount: 0, courierId: null, courierName: null, option: null, quoted: false };
  }
}
