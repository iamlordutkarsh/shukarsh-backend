-- One click of "I forgot my password".
--
-- Only the SHA-256 of the emailed token is stored, never the token itself, so a
-- dump of this table cannot be used to take an account: an attacker holding a
-- hash still has nothing to put in the link.
--
-- Single use and short lived, both enforced when the token is redeemed rather
-- than by a cleanup job that may not have run. `usedAt` is kept rather than the
-- row being deleted, so a link that arrives twice can be told apart from one
-- that was never issued.
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- Unique because the hash is what a redemption looks the row up by.
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- Asking for a new link retires the ones already outstanding, which is a lookup
-- by user.
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- Cascade: closing an account must not leave a live reset link behind it.
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
