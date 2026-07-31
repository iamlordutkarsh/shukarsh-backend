import { canonicalState } from "./address";

/** The slabs GST actually uses. Anything outside this list is a typo. */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

const FALLBACK_RATE = 5;

export function sellerState(): string | null {
  const raw = process.env.SELLER_STATE;
  return raw ? canonicalState(raw) : null;
}

export function sellerGstin(): string | null {
  return process.env.SELLER_GSTIN?.trim() || null;
}

/**
 * Deciding between CGST+SGST and IGST needs to know where the seller is, so an
 * unset SELLER_STATE turns GST off rather than guessing and putting the wrong
 * heads on every invoice. Same shape as Shiprocket: missing configuration
 * degrades to a store that still sells, it does not break checkout.
 */
export function isGstEnabled(): boolean {
  if (process.env.GST_ENABLED === "false") return false;
  return sellerState() !== null;
}

export function defaultGstRate(): number {
  const raw = Number(process.env.GST_DEFAULT_RATE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : FALLBACK_RATE;
}

/**
 * Delivery is part of a composite supply, so it carries the rate of the
 * principal goods rather than one of its own. Set GST_ON_SHIPPING=false to
 * leave it untaxed.
 */
function shippingIsTaxed(): boolean {
  return process.env.GST_ON_SHIPPING !== "false";
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface TaxableLine {
  productId: string;
  /** What the customer pays for this line, GST already inside it. */
  gross: number;
  rate: number;
}

export interface TaxedLine extends TaxableLine {
  taxable: number;
  tax: number;
}

/** One row of the rate-wise table an invoice has to show. */
export interface RateBucket {
  rate: number;
  taxable: number;
  tax: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface TaxBreakdown {
  enabled: boolean;
  intraState: boolean;
  placeOfSupply: string | null;
  taxableTotal: number;
  taxTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  shippingTax: number;
  codTax: number;
  lines: TaxedLine[];
  buckets: RateBucket[];
}

/** Halves a tax figure without letting the halves drift off the whole. */
function splitTax(tax: number, intraState: boolean): { cgst: number; sgst: number; igst: number } {
  if (!intraState) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = round2(tax / 2);
  return { cgst, sgst: round2(tax - cgst), igst: 0 };
}

/** Pulls the GST back out of a tax-inclusive amount. */
function taxInside(gross: number, rate: number): number {
  if (rate <= 0) return 0;
  return round2(gross - gross / (1 + rate / 100));
}

/**
 * Splits tax-inclusive amounts into what the seller keeps and what the
 * government gets.
 *
 * Prices on the site are MRP, so this never changes what anyone is charged. It
 * only reports how much GST was already inside the total. The tax is rounded
 * first and the taxable value derived by subtraction, which keeps
 * taxable + tax exactly equal to the gross on every single line. Rounding each
 * half independently would let the invoice disagree with the amount actually
 * paid by a paisa or two, which is the kind of thing an auditor notices.
 *
 * Pass gross amounts that already have any discount taken off them: GST is
 * charged on what the customer really pays, not on the pre-discount price.
 */
export function computeTax(params: {
  lines: TaxableLine[];
  shippingGross: number;
  /**
   * The cash-collection fee, which rides with delivery: both are ancillary to
   * the goods, so both take the principal supply's rate. Left out of the buckets
   * it would be charged to the customer but missing from the rate-wise table,
   * and the invoice would not add up to what was paid.
   */
  codGross?: number;
  buyerState: string | null;
}): TaxBreakdown {
  const codGross = params.codGross ?? 0;
  const seller = sellerState();
  const buyer = params.buyerState ? canonicalState(params.buyerState) : null;

  // An unrecognised buyer state falls back to the intra-state split. The address
  // schema canonicalises state before anything reaches here, so this is close to
  // unreachable, and treating it as local is the conservative half.
  const intraState = seller !== null && buyer !== null ? buyer === seller : true;

  if (!isGstEnabled()) {
    const gross =
      params.lines.reduce((total, line) => total + line.gross, 0) + params.shippingGross + codGross;

    return {
      enabled: false,
      intraState,
      placeOfSupply: buyer,
      taxableTotal: round2(gross),
      taxTotal: 0,
      cgstTotal: 0,
      sgstTotal: 0,
      igstTotal: 0,
      shippingTax: 0,
      codTax: 0,
      // The rate is zeroed rather than carried through. These lines are what an
      // order stores, and "5% applicable, ₹0 collected" is indistinguishable
      // from a rounding bug when someone reconciles it later.
      lines: params.lines.map((line) => ({ ...line, rate: 0, taxable: round2(line.gross), tax: 0 })),
      buckets: [],
    };
  }

  const lines: TaxedLine[] = params.lines.map((line) => {
    const tax = taxInside(line.gross, line.rate);
    return { ...line, tax, taxable: round2(line.gross - tax) };
  });

  // The principal supply sets the rate delivery is taxed at. With a mixed bag
  // that is the item carrying the most value.
  const principal = params.lines.reduce<TaxableLine | null>(
    (highest, line) => (highest === null || line.gross > highest.gross ? line : highest),
    null
  );
  const shippingRate = shippingIsTaxed() && principal ? principal.rate : 0;
  const shippingTax = taxInside(params.shippingGross, shippingRate);
  const codTax = taxInside(codGross, shippingRate);

  const buckets = new Map<number, RateBucket>();
  const addToBucket = (rate: number, gross: number, tax: number) => {
    if (gross <= 0) return;
    const bucket = buckets.get(rate) ?? { rate, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0 };
    bucket.taxable = round2(bucket.taxable + (gross - tax));
    bucket.tax = round2(bucket.tax + tax);
    buckets.set(rate, bucket);
  };

  for (const line of lines) addToBucket(line.rate, line.gross, line.tax);
  addToBucket(shippingRate, params.shippingGross, shippingTax);
  addToBucket(shippingRate, codGross, codTax);

  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  for (const bucket of buckets.values()) {
    const split = splitTax(bucket.tax, intraState);
    bucket.cgst = split.cgst;
    bucket.sgst = split.sgst;
    bucket.igst = split.igst;
    cgstTotal = round2(cgstTotal + split.cgst);
    sgstTotal = round2(sgstTotal + split.sgst);
    igstTotal = round2(igstTotal + split.igst);
  }

  const taxTotal = round2(cgstTotal + sgstTotal + igstTotal);
  const grossTotal =
    params.lines.reduce((total, line) => total + line.gross, 0) + params.shippingGross + codGross;

  return {
    enabled: true,
    intraState,
    placeOfSupply: buyer,
    taxableTotal: round2(grossTotal - taxTotal),
    taxTotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    shippingTax,
    codTax,
    lines,
    buckets: [...buckets.values()].sort((a, b) => a.rate - b.rate),
  };
}
