const BASE_URL = process.env.RAZORPAY_API_BASE_URL || "https://api.razorpay.com";
const TIMEOUT_MS = Number(process.env.RAZORPAY_REQUEST_TIMEOUT_MS) || 20000;

export function isRefundConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export class RefundError extends Error {
  status: number;
  /** Whether pressing the button again could reasonably work. */
  retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "RefundError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Rupees to paise.
 *
 * Razorpay counts in paise and rejects anything that is not a whole number, and
 * 452.38 * 100 is 45237.999999999996 in binary floating point. Rounding rather
 * than truncating, because the truncated version quietly short-pays the customer
 * by a paisa on most amounts.
 */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export interface RefundResult {
  id: string;
  status: string;
  amountPaise: number;
}

/**
 * Sends money back for one return.
 *
 * The return's own id is the idempotency key, which is what makes this safe to
 * press twice. Razorpay holds the outcome against that key, so a request that
 * timed out on the way back can be repeated and will return the original refund
 * rather than making a second one. That matters more than anything else here: a
 * network blip must never be able to pay a customer twice.
 *
 * Normal speed, deliberately. The optimum setting is instant when it can be, but
 * Razorpay charges for each one, and nobody returning a dress is waiting by the
 * phone for the money.
 */
export async function issueRefund(input: {
  returnId: string;
  paymentId: string;
  amountRupees: number;
  orderReference: string;
}): Promise<RefundResult> {
  if (!isRefundConfigured()) {
    throw new RefundError("Razorpay is not configured, so refunds cannot be sent", 503, false);
  }

  const amount = toPaise(input.amountRupees);
  if (!Number.isFinite(amount) || amount < 100) {
    // Razorpay's own floor is ₹1, and an amount of 0 is read as "refund everything",
    // which is the last mistake this should be capable of making.
    throw new RefundError("A refund has to be at least ₹1", 400, false);
  }

  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
  ).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/v1/payments/${input.paymentId}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        // Must not change between attempts, or Razorpay treats it as a new refund.
        "X-Refund-Idempotency": input.returnId,
      },
      body: JSON.stringify({
        amount,
        speed: "normal",
        receipt: input.returnId,
        notes: { returnId: input.returnId, order: input.orderReference },
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const body = text ? safeParse(text) : null;

    if (response.status === 409) {
      throw new RefundError(
        "This refund is already going through. Give it a minute, then look again before trying anything else.",
        409,
        true
      );
    }

    if (!response.ok || !body?.id) {
      throw new RefundError(
        body?.error?.description || `Razorpay refused the refund (${response.status})`,
        response.status,
        // Their fault, so worth another go. Ours, and the request needs fixing first.
        response.status >= 500
      );
    }

    return {
      id: String(body.id),
      status: body.status ? String(body.status) : "pending",
      amountPaise: Number(body.amount ?? amount),
    };
  } catch (error) {
    if (error instanceof RefundError) throw error;

    // A timeout is the dangerous case: the refund may well have been made. Say so
    // plainly, and rely on the idempotency key to make the retry safe.
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new RefundError(
      aborted
        ? "Razorpay did not answer in time. The refund may still have gone through, so check before sending another."
        : error instanceof Error
          ? error.message
          : "Could not reach Razorpay",
      504,
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
