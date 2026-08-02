import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

/**
 * Every session token is signed with this, so an attacker who knows it can mint
 * one for any account, admin included — and the old fallback was a fixed string
 * sitting in a public repo. Unset in production that is not a weak secret, it is
 * no secret at all, and nothing about the running shop looks wrong.
 *
 * So production refuses to start rather than serve forgeable tokens quietly.
 * Outside production the fallback stays, because a checkout cannot be tested on
 * a machine that will not boot.
 */
function requireSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start: every session token would be " +
        "signed with a value published in the repository."
    );
  }

  return "fallback-secret-change-in-production";
}

const JWT_SECRET = requireSecret();
const JWT_EXPIRES_IN = "7d";

export interface TokenPayload {
  id: string;
  email: string;
  role: UserRole;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hashedPassword: string): boolean {
  return bcrypt.compareSync(password, hashedPassword);
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
