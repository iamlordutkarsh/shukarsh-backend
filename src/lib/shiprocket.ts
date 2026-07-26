const BASE_URL = process.env.SHIPROCKET_API_BASE_URL || "https://apiv2.shiprocket.in";
const TIMEOUT_MS = Number(process.env.SHIPROCKET_REQUEST_TIMEOUT_MS) || 15000;
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000;

export function isShiprocketConfigured(): boolean {
  return Boolean(
    process.env.SHIPROCKET_EMAIL &&
      process.env.SHIPROCKET_PASSWORD &&
      process.env.SHIPROCKET_PICKUP_LOCATION
  );
}

export function pickupPincode(): string {
  return process.env.SHIPROCKET_PICKUP_PINCODE || "";
}

export class ShiprocketError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ShiprocketError";
    this.status = status;
    this.payload = payload;
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;
let loginInFlight: Promise<string> | null = null;

async function fetchJson(path: string, init: RequestInit): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    const body = text ? safeParse(text) : null;
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function messageFrom(body: any, fallback: string): string {
  if (!body) return fallback;
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  if (body.errors && typeof body.errors === "object") {
    const first = Object.values(body.errors)[0];
    if (Array.isArray(first) && typeof first[0] === "string") return first[0];
  }
  return fallback;
}

/** Single-flight login so concurrent calls never burn two tokens. */
async function login(): Promise<string> {
  if (loginInFlight) return loginInFlight;

  loginInFlight = (async () => {
    const { status, body } = await fetchJson("/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }),
    });

    if (status !== 200 || !body?.token) {
      throw new ShiprocketError(messageFrom(body, "Shiprocket login failed"), status, body);
    }

    tokenCache = { token: body.token as string, expiresAt: Date.now() + TOKEN_TTL_MS };
    return tokenCache.token;
  })();

  try {
    return await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  return login();
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function call<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!isShiprocketConfigured()) {
    throw new ShiprocketError("Shiprocket is not configured", 503, null);
  }

  const method = options.method ?? "GET";
  const search = new URLSearchParams();
  Object.entries(options.query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const url = search.toString() ? `${path}?${search.toString()}` : path;

  const send = async (token: string) =>
    fetchJson(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

  let { status, body } = await send(await getToken());

  if (status === 401) {
    tokenCache = null;
    ({ status, body } = await send(await login()));
  }

  if (status < 200 || status >= 300) {
    throw new ShiprocketError(messageFrom(body, `Shiprocket request failed (${status})`), status, body);
  }

  return body as T;
}

export interface CourierOption {
  courierId: number;
  courierName: string;
  rate: number;
  etd: string | null;
  etdDays: number | null;
  isSurface: boolean;
  rating: number | null;
  chargeWeightKg: number | null;
  recommended: boolean;
}

export interface ServiceabilityResult {
  serviceable: boolean;
  options: CourierOption[];
  blocked: { courierName: string; reason: string }[];
}

export async function getServiceability(params: {
  deliveryPincode: string;
  weightKg: number;
  declaredValue: number;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
}): Promise<ServiceabilityResult> {
  const data = await call<any>("/v1/external/courier/serviceability/", {
    query: {
      pickup_postcode: pickupPincode(),
      delivery_postcode: params.deliveryPincode,
      weight: params.weightKg.toFixed(2),
      cod: 0,
      declared_value: Math.round(params.declaredValue),
      length: params.lengthCm,
      breadth: params.breadthCm,
      height: params.heightCm,
    },
  });

  const recommendedId = data?.data?.recommended_courier_company_id ?? null;
  const available: any[] = data?.data?.available_courier_companies ?? [];

  const options: CourierOption[] = available
    .filter((courier) => Number(courier.blocked ?? 0) === 0 && courier.odablock !== true)
    .map((courier) => ({
      courierId: Number(courier.courier_company_id),
      courierName: String(courier.courier_name ?? "Courier"),
      rate: Number(courier.rate ?? 0),
      etd: courier.etd ? String(courier.etd) : null,
      etdDays: courier.estimated_delivery_days ? Number(courier.estimated_delivery_days) : null,
      isSurface: Boolean(courier.is_surface),
      rating: courier.rating ? Number(courier.rating) : null,
      chargeWeightKg: courier.charge_weight ? Number(courier.charge_weight) : null,
      recommended: Number(courier.courier_company_id) === Number(recommendedId),
    }))
    .sort((a, b) => a.rate - b.rate);

  const blocked = (data?.data?.blocked_courier_companies ?? []).map((courier: any) => ({
    courierName: String(courier.courier_name ?? "Courier"),
    reason: String(courier.block_reason ?? "Unavailable"),
  }));

  return { serviceable: options.length > 0, options, blocked };
}

export interface PincodeDetails {
  city: string | null;
  state: string | null;
  stateCode: string | null;
}

export async function getPincodeDetails(pincode: string): Promise<PincodeDetails> {
  const data = await call<any>("/v1/external/open/postcode/details", { query: { postcode: pincode } });
  const details = data?.postcode_details ?? {};

  return {
    city: details.city ? String(details.city) : null,
    state: details.state ? String(details.state) : null,
    stateCode: details.state_code ? String(details.state_code) : null,
  };
}

export interface CreateOrderPayload {
  reference: string;
  orderDate: string;
  customerName: string;
  lastName?: string;
  address: string;
  address2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  email: string;
  phone: string;
  items: { name: string; sku: string; units: number; sellingPrice: number; hsn?: string }[];
  subTotal: number;
  shippingCharges: number;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

export interface CreateOrderResult {
  providerOrderId: string;
  providerShipmentId: string;
  status: string | null;
  statusCode: number | null;
}

export async function createAdhocOrder(payload: CreateOrderPayload): Promise<CreateOrderResult> {
  const body = {
    order_id: payload.reference,
    order_date: payload.orderDate,
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION,
    channel_id: process.env.SHIPROCKET_CHANNEL_ID ? Number(process.env.SHIPROCKET_CHANNEL_ID) : undefined,
    billing_customer_name: payload.customerName,
    billing_last_name: payload.lastName ?? "",
    billing_address: payload.address,
    billing_address_2: payload.address2 ?? "",
    billing_city: payload.city.slice(0, 30),
    billing_pincode: Number(payload.pincode),
    billing_state: payload.state,
    billing_country: payload.country,
    billing_email: payload.email,
    billing_phone: Number(payload.phone),
    shipping_is_billing: true,
    order_items: payload.items.map((item) => ({
      name: item.name.slice(0, 100),
      sku: item.sku,
      units: item.units,
      selling_price: Math.round(item.sellingPrice),
      discount: 0,
      tax: 0,
      ...(item.hsn ? { hsn: Number(item.hsn) } : {}),
    })),
    payment_method: "Prepaid",
    sub_total: Math.round(payload.subTotal),
    shipping_charges: Math.round(payload.shippingCharges),
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    length: Math.max(1, payload.lengthCm),
    breadth: Math.max(1, payload.breadthCm),
    height: Math.max(1, payload.heightCm),
    weight: Math.max(0.1, Number(payload.weightKg.toFixed(3))),
  };

  const data = await call<any>("/v1/external/orders/create/adhoc", { method: "POST", body });

  if (!data?.shipment_id) {
    throw new ShiprocketError(messageFrom(data, "Shiprocket did not return a shipment id"), 502, data);
  }

  return {
    providerOrderId: String(data.order_id),
    providerShipmentId: String(data.shipment_id),
    status: data.status ? String(data.status) : null,
    statusCode: data.status_code != null ? Number(data.status_code) : null,
  };
}

export interface AwbResult {
  awb: string;
  courierId: number | null;
  courierName: string | null;
  appliedWeightKg: number | null;
  pickupScheduledAt: string | null;
}

export async function assignAwb(shipmentId: string, courierId?: number): Promise<AwbResult> {
  const data = await call<any>("/v1/external/courier/assign/awb", {
    method: "POST",
    body: { shipment_id: shipmentId, ...(courierId ? { courier_id: courierId } : {}) },
  });

  const details = data?.response?.data;
  if (Number(data?.awb_assign_status) !== 1 || !details?.awb_code) {
    throw new ShiprocketError(messageFrom(data, "Could not assign an AWB for this shipment"), 502, data);
  }

  return {
    awb: String(details.awb_code),
    courierId: details.courier_company_id != null ? Number(details.courier_company_id) : null,
    courierName: details.courier_name ? String(details.courier_name) : null,
    appliedWeightKg: details.applied_weight != null ? Number(details.applied_weight) : null,
    pickupScheduledAt: details.pickup_scheduled_date ? String(details.pickup_scheduled_date) : null,
  };
}

export async function generateLabel(shipmentId: string): Promise<string> {
  const data = await call<any>("/v1/external/courier/generate/label", {
    method: "POST",
    body: { shipment_id: [shipmentId] },
  });

  if (Number(data?.label_created) !== 1 || !data?.label_url) {
    throw new ShiprocketError(messageFrom(data, "Label could not be created"), 502, data);
  }

  return String(data.label_url);
}

export async function generateInvoice(providerOrderId: string): Promise<string> {
  const data = await call<any>("/v1/external/orders/print/invoice", {
    method: "POST",
    body: { ids: [providerOrderId] },
  });

  if (data?.is_invoice_created !== true || !data?.invoice_url) {
    throw new ShiprocketError(messageFrom(data, "Invoice could not be created"), 502, data);
  }

  return String(data.invoice_url);
}

export async function requestPickup(
  shipmentId: string,
  pickupDate?: string
): Promise<{ scheduledAt: string | null; token: string | null }> {
  const data = await call<any>("/v1/external/courier/generate/pickup", {
    method: "POST",
    body: { shipment_id: [Number(shipmentId)], ...(pickupDate ? { pickup_date: [pickupDate] } : {}) },
  });

  if (Number(data?.pickup_status) !== 1) {
    throw new ShiprocketError(messageFrom(data?.response ?? data, "Pickup could not be scheduled"), 502, data);
  }

  return {
    scheduledAt: data?.response?.pickup_scheduled_date ? String(data.response.pickup_scheduled_date) : null,
    token: data?.response?.pickup_token_number ? String(data.response.pickup_token_number) : null,
  };
}

export async function generateManifest(shipmentId: string): Promise<string> {
  const data = await call<any>("/v1/external/manifests/generate", {
    method: "POST",
    body: { shipment_id: [Number(shipmentId)] },
  });

  if (!data?.manifest_url) {
    throw new ShiprocketError(messageFrom(data, "Manifest could not be generated"), 502, data);
  }

  return String(data.manifest_url);
}

export interface TrackingEvent {
  date: string | null;
  activity: string | null;
  location: string | null;
  status: string | null;
  statusLabel: string | null;
}

export interface TrackingResult {
  awb: string | null;
  courierName: string | null;
  currentStatus: string | null;
  statusCode: number | null;
  trackUrl: string | null;
  etd: string | null;
  deliveredAt: string | null;
  events: TrackingEvent[];
}

export function normalizeEvents(scans: any[]): TrackingEvent[] {
  return (scans ?? []).map((scan) => ({
    date: scan?.date ? String(scan.date) : null,
    activity: scan?.activity ? String(scan.activity) : null,
    location: scan?.location ? String(scan.location) : null,
    status: scan?.status ? String(scan.status) : null,
    statusLabel: scan?.["sr-status-label"] && scan["sr-status-label"] !== "NA" ? String(scan["sr-status-label"]) : null,
  }));
}

export async function trackByAwb(awb: string): Promise<TrackingResult> {
  const data = await call<any>(`/v1/external/courier/track/awb/${encodeURIComponent(awb)}`);
  const tracking = data?.tracking_data ?? {};
  const track = Array.isArray(tracking.shipment_track) ? tracking.shipment_track[0] : null;

  return {
    awb: track?.awb_code ? String(track.awb_code) : awb,
    courierName: track?.courier_name ? String(track.courier_name) : null,
    currentStatus: track?.current_status ? String(track.current_status) : null,
    statusCode: tracking.shipment_status != null ? Number(tracking.shipment_status) : null,
    trackUrl: tracking.track_url ? String(tracking.track_url) : null,
    etd: tracking.etd ? String(tracking.etd) : track?.edd ? String(track.edd) : null,
    deliveredAt: track?.delivered_date ? String(track.delivered_date) : null,
    events: normalizeEvents(tracking.shipment_track_activities),
  };
}

export async function cancelShipmentByAwb(awb: string): Promise<void> {
  await call("/v1/external/orders/cancel/shipment/awbs", { method: "POST", body: { awbs: [awb] } });
}

export async function cancelProviderOrder(providerOrderId: string): Promise<void> {
  await call("/v1/external/orders/cancel", { method: "POST", body: { ids: [Number(providerOrderId)] } });
}

export async function listPickupLocations(): Promise<{ nickname: string; pincode: string | null }[]> {
  const data = await call<any>("/v1/external/settings/company/pickup");
  const addresses: any[] = data?.data?.shipping_address ?? [];

  return addresses.map((address) => ({
    nickname: String(address.pickup_location),
    pincode: address.pin_code ? String(address.pin_code) : null,
  }));
}

/** Shiprocket status code -> our OrderStatus. */
export function orderStatusFromCode(code: number | null | undefined): string | null {
  if (code == null) return null;

  const shipped = [6, 42, 51, 52, 18, 38, 50, 54, 55, 56, 57, 68];
  const outForDelivery = [17];
  const processing = [1, 5, 19, 27, 59, 60, 61, 62, 63, 67];
  const delivered = [7, 26, 43];
  const cancelled = [8, 16, 45];
  const returned = [9, 10, 14, 40, 41, 46, 75, 78];

  if (delivered.includes(code)) return "DELIVERED";
  if (returned.includes(code)) return "RETURNED";
  if (cancelled.includes(code)) return "CANCELLED";
  if (outForDelivery.includes(code) || shipped.includes(code)) return "SHIPPED";
  if (processing.includes(code)) return "PROCESSING";
  return null;
}
