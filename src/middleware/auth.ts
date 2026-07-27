import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/auth";
import { UserRole } from "@prisma/client";

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * Whether the caller is a signed-in admin, for endpoints that serve everyone
 * but hold back some fields.
 *
 * Never rejects: an absent or rotten token just means "treat them as a
 * shopper", which is the safe half.
 */
export function isAdminRequest(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;

  try {
    return verifyToken(header.slice(7)).role === UserRole.ADMIN;
  } catch {
    return false;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.user.role !== UserRole.ADMIN) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
