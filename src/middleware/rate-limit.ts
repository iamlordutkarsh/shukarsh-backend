import rateLimit from "express-rate-limit";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Password grinding guard. Successful sign ins are not counted, so a household
 * or office sharing one IP is never locked out by its own valid logins.
 */
export const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_LOGIN_MAX) || 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign in attempts. Please wait a few minutes and try again." },
});

/**
 * Reset request cap.
 *
 * Every request is counted, successes included: the point is not to stop
 * guessing but to stop the endpoint being used to post mail at somebody. Without
 * it, one address can be sent a hundred reset emails by anyone who knows it, and
 * the shop's sending domain wears the complaint.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_PASSWORD_RESET_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reset requests. Please wait a few minutes and try again." },
});

/**
 * Review writing cap.
 *
 * Only delivered customers can post at all, so this is not the spam defence; it
 * is there because one row per person per product means a stuck client can spend
 * the afternoon rewriting the same review, and each attempt is a write.
 */
export const reviewLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_REVIEW_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many review updates. Please wait a few minutes and try again." },
});

/** Every attempt counts here, since the point is to cap account creation. */
export const registerLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_REGISTER_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many accounts created from here. Please try again later." },
});

/**
 * Guessing guard for coupon codes. A rejection and an acceptance are plainly
 * different answers, so an uncapped endpoint hands the whole code list to
 * anyone with a word list and a few minutes. Successes count too: a working
 * code found on the tenth try is still a code found.
 */
export const couponLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_COUPON_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many code attempts. Please wait a few minutes and try again." },
});

/**
 * Caps what a signed-in customer can push into our storage bucket. Return
 * photos are the one upload the public side of the site can reach, and an
 * uncapped one is a free image host on somebody else's bill.
 */
export const customerUploadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_UPLOAD_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads. Please wait a few minutes and try again." },
});

/**
 * Guards the one public endpoint that reads an order.
 *
 * A recovery link is signed, so guessing the token is the only way in, and a cap
 * turns that from slow into pointless. Nobody legitimately follows the link in
 * their email more than a handful of times.
 */
export const recoveryLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_RECOVERY_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

/**
 * Placing an order.
 *
 * Not a guessing guard like the others: this endpoint takes no login, and a cash
 * order moves stock off the shelf the moment it is placed. Uncapped, a loop of
 * guest COD orders empties the catalogue without a rupee changing hands, and
 * every prepaid attempt opens a Razorpay order we then have to reconcile.
 *
 * Loose enough that a household behind one address can all check out, and a
 * customer who fumbles the payment sheet a few times is never turned away.
 */
export const checkoutLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_CHECKOUT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Please wait a few minutes and try again." },
});

/**
 * The same guard for pricing a bag, which also takes a code. Set far higher
 * because the checkout page calls it legitimately on every keystroke of an
 * address: too tight here and checkout stops showing a total.
 */
export const quoteLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_QUOTE_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many pricing requests. Please wait a moment and try again." },
});
