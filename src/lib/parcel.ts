export interface ParcelItem {
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  quantity: number;
}

export interface Parcel {
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

const MIN_WEIGHT_KG = 0.5;

/** Everything ships as one box: widest footprint, stacked height, summed weight. */
export function computeParcel(items: ParcelItem[]): Parcel {
  if (items.length === 0) {
    return { weightKg: MIN_WEIGHT_KG, lengthCm: 15, breadthCm: 12, heightCm: 6 };
  }

  const weight = items.reduce((total, item) => total + item.weightKg * item.quantity, 0);
  const length = Math.max(...items.map((item) => item.lengthCm));
  const breadth = Math.max(...items.map((item) => item.breadthCm));
  const stacked = items.reduce((total, item) => total + item.heightCm * item.quantity, 0);

  return {
    weightKg: Math.max(MIN_WEIGHT_KG, Number(weight.toFixed(3))),
    lengthCm: Math.max(1, Math.round(length)),
    breadthCm: Math.max(1, Math.round(breadth)),
    heightCm: Math.max(1, Math.round(Math.min(stacked, 120))),
  };
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Serviceability rarely changes and the provider rate-limits, so bucket and cache it. */
export function createTtlCache<T>(ttlSeconds: number) {
  const store = new Map<string, CacheEntry<T>>();

  return {
    get(key: string): T | null {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: T) {
      if (store.size > 500) store.clear();
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
  };
}

export function weightBucket(weightKg: number): string {
  return (Math.ceil(weightKg * 2) / 2).toFixed(1);
}
