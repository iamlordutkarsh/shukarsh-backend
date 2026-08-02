import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";

/**
 * Long enough that guessing is not a strategy, short enough to survive a mail
 * client wrapping the link. 32 bytes of urlsafe base64 is 43 characters.
 */
const TOKEN_BYTES = 32;

/**
 * An hour. A reset link is a password in an inbox: long windows mean a forwarded
 * or shoulder-read mail still opens the account tomorrow. Long enough to notice
 * the mail and act on it, short enough that a stale one is useless.
 */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a token and returns the plaintext, which is the only time it exists
 * outside the email. Any link already outstanding for this account is spent
 * first, so asking twice cannot leave two working links behind.
 */
export async function issueResetToken(userId: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    }),
  ]);

  return token;
}

/**
 * The account a token is good for, or null.
 *
 * Compared against the stored hash in constant time. The lookup is by hash, so
 * the database index does the finding and the comparison only guards against a
 * hash collision being probed byte by byte, but the cost is a few microseconds
 * and the alternative is reasoning about it again later.
 */
export async function consumeResetToken(token: string): Promise<string | null> {
  if (!token) return null;

  const digest = hash(token);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: digest } });
  if (!row) return null;

  const stored = Buffer.from(row.tokenHash);
  const offered = Buffer.from(digest);
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) return null;

  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  // Spent by the same statement that checks it is unspent, so two requests
  // arriving together cannot both come away holding a valid token.
  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (count === 0) return null;

  return row.userId;
}
