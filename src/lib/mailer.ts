const API_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = Number(process.env.EMAIL_REQUEST_TIMEOUT_MS) || 10000;

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export interface Email {
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends through Resend's REST API directly, so no SDK is needed.
 *
 * Never throws: a receipt failing to send must not roll back a payment or stop
 * a shipment being created. Callers fire and forget.
 */
export async function sendEmail(email: Email): Promise<boolean> {
  if (!isEmailConfigured()) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error("Email send failed:", response.status, await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error("Email send failed:", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
