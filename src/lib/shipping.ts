import { prisma } from "./prisma";
import { computeParcel, createTtlCache, weightBucket, type Parcel } from "./parcel";
import { shippingFee } from "./shipping-policy";
import { round2 } from "./tax";
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
  gstRate: number;
  categoryId: string;
  /** Per unit and net of GST. Null when nobody has recorded one. */
  costPrice: number | null;
  /** price × quantity, GST included, since the listed price is the MRP. */
  gross: number;
}

export interface PricedCart {
  lines: PricedLine[];
  itemsTotal: number;
  parcel: Parcel;
}

/**
 * One entry per product, quantities added up.
 *
 * The bag arrives as an array and /api/orders/create is public, so the same
 * product can turn up in it twice. Checked line by line, 5 and 5 both pass
 * against a stock of 8 and the order oversells by two. Nothing downstream
 * minds: tax and discounts are mapped by line position against the lines
 * priceCart returns, which are these.
 */
export function collapseLines(items: CartLine[]): CartLine[] {
  const quantities = new Map<string, number>();

  for (const item of items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }

  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

export interface PriceCartOptions {
  /**
   * Set for a bag that has already been bought.
   *
   * A bag someone is still deciding on has to be coverable right now: in stock
   * and still for sale. A placed order is neither question. Its units came off
   * the shelf the moment the payment landed and the shop may have delisted the
   * product since, so asking again refuses to let the last one out of the door:
   * an order that emptied the stock could not be shipped at all.
   */
  placed?: boolean;
}

/** Prices and weights always come from the database, never from the client. */
export async function priceCart(
  cartItems: CartLine[],
  options?: PriceCartOptions
): Promise<PricedCart> {
  const items = collapseLines(cartItems);
  const ids = items.map((item) => item.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, ...(options?.placed ? {} : { isActive: true }) },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      stock: true,
      hsn: true,
      gstRate: true,
      categoryId: true,
      costPrice: true,
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
    if (!options?.placed && product.stock < item.quantity) {
      throw Object.assign(new Error(`Only ${product.stock} left of ${product.name}`), { statusCode: 409 });
    }

    lines.push({
      productId: product.id,
      name: product.name,
      slug: product.slug,
      quantity: item.quantity,
      price: Number(product.price),
      hsn: product.hsn,
      gstRate: Number(product.gstRate),
      categoryId: product.categoryId,
      costPrice: product.costPrice != null ? Number(product.costPrice) : null,
      gross: round2(Number(product.price) * item.quantity),
    });

    parcelItems.push({
      weightKg: Number(product.weightKg),
      lengthCm: product.lengthCm,
      breadthCm: product.breadthCm,
      heightCm: product.heightCm,
      quantity: item.quantity,
    });
  }

  const itemsTotal = round2(lines.reduce((total, line) => total + line.gross, 0));

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
  /**
   * False only when the courier account answered and no one covers the pincode.
   * Null when we could not ask, which must not be read as a refusal: an outage
   * on our side is no reason to turn away an order we can almost certainly ship.
   */
  serviceable: boolean | null;
}

/**
 * The cheapest courier that still gets there in reasonable time.
 *
 * Shiprocket's own `recommended` flag is not costed. Bareilly to Lucknow, half a
 * kilo: ₹55 with the cheapest courier and ₹96 recommended, and across 33
 * pincodes the recommendation ran ₹57 over the cheapest on a median parcel and
 * ₹107 on a kilo (`npm run rates:survey`). Since the customer no longer picks a
 * courier and delivery is on the shop, that difference was pure loss.
 *
 * The cap is what stops "cheapest" turning into "eventually": below it, price
 * decides, and if nothing is inside it we take the cheapest anyway rather than
 * refuse the order. An admin's explicit choice always wins.
 */
export function pickCourier(options: CourierOption[], preferredCourierId?: number): CourierOption {
  if (preferredCourierId) {
    const preferred = options.find((option) => option.courierId === preferredCourierId);
    if (preferred) return preferred;
  }

  const cap = positiveInt(process.env.SHIPPING_MAX_ETD_DAYS, 7);

  // getServiceability sorts by rate, so the first match is the cheapest one.
  return options.find((option) => option.etdDays == null || option.etdDays <= cap) ?? options[0];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * What the customer pays to have this delivered, and who we will book to carry
 * it. Two separate questions: the price comes from the shop's own policy, the
 * courier from what is actually available today.
 *
 * Keeping them separate is what lets the shop keep taking orders when the
 * courier account is unreachable. The old version priced delivery off the live
 * rate and fell back to zero, so an outage quietly made shipping free on every
 * order. Now a failed quote costs us the courier's name, not the fee.
 */
export async function resolveShipping(params: {
  pincode: string;
  parcel: Parcel;
  /** What the customer is paying for the goods, after any coupon. */
  orderValue: number;
  preferredCourierId?: number;
}): Promise<ResolvedShipping> {
  const amount = shippingFee(params.orderValue);
  const unquoted: ResolvedShipping = {
    amount,
    courierId: null,
    courierName: null,
    option: null,
    quoted: false,
    serviceable: null,
  };

  if (!isShiprocketConfigured() || !pickupPincode()) return unquoted;

  try {
    // Insurance and the free-delivery threshold key off the same figure: what is
    // actually being paid.
    const { options } = await quoteShipping({ ...params, declaredValue: params.orderValue });
    if (options.length === 0) return { ...unquoted, serviceable: false };

    const chosen = pickCourier(options, params.preferredCourierId);

    return {
      amount,
      courierId: chosen.courierId,
      courierName: chosen.courierName,
      option: chosen,
      quoted: true,
      serviceable: true,
    };
  } catch (error) {
    console.error("Shipping quote failed:", error);
    return unquoted;
  }
}
