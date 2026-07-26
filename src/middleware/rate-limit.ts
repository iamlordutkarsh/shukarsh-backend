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

/** Every attempt counts here, since the point is to cap account creation. */
export const registerLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: Number(process.env.RATE_LIMIT_REGISTER_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many accounts created from here. Please try again later." },
});
