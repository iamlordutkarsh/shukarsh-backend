-- One address is one account. Sign-in compared emails exactly as typed, so
-- Priya@gmail.com and priya@gmail.com were two different people, with the orders
-- split between them and no way back into whichever one you were not holding.

-- Lowercase every address that can be lowercased without landing on top of
-- another row.
--
-- A pair differing only by case is left exactly as it is. Deciding which of two
-- accounts is the real one means choosing whose orders and whose password
-- survive, which is a person's decision and not a migration's. `npm run
-- check:emails` lists anything left behind, and sign-in reaches both in the
-- meantime by falling back to a case-insensitive match.
UPDATE "User" AS u
SET "email" = lower(u."email")
WHERE u."email" <> lower(u."email")
  AND NOT EXISTS (
    SELECT 1
    FROM "User" AS other
    WHERE other."id" <> u."id"
      AND lower(other."email") = lower(u."email")
  );

-- A unique index on lower("email") would make this impossible rather than merely
-- fixed, but creating one fails outright if any duplicate survived the statement
-- above, and a failed migration is a failed deploy. It waits for a follow-up
-- migration, once check:emails has confirmed there is nothing in the way.

-- Newsletter rows hold nothing but an address and a date, so a duplicate that
-- differs only by case is not a decision, it is just one person being sent every
-- campaign twice. Keep the earliest and drop the rest, then the lowercasing
-- below has nothing left to collide with.
DELETE FROM "NewsletterSubscriber" AS s
WHERE EXISTS (
  SELECT 1
  FROM "NewsletterSubscriber" AS other
  WHERE lower(other."email") = lower(s."email")
    AND (
      other."createdAt" < s."createdAt"
      OR (other."createdAt" = s."createdAt" AND other."id" < s."id")
    )
);

UPDATE "NewsletterSubscriber"
SET "email" = lower("email")
WHERE "email" <> lower("email");