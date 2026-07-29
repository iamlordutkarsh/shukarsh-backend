import { z } from "zod";
import { prisma } from "./prisma";

/**
 * One address is one account, however it was typed.
 *
 * Mailbox names are case-sensitive by the letter of the standard and by the
 * practice of no mail provider anybody actually uses. A phone keyboard
 * capitalising the first letter is not a customer choosing a second account, but
 * comparing addresses exactly made it one: signing up as Priya@gmail.com and
 * later typing priya@gmail.com found nothing, so the orders ended up split over
 * two identities with no way back into the first.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalises before validating, so what gets stored is what will be searched for. */
export const emailField = z.string().trim().toLowerCase().email();

/**
 * Finds an account whatever case it happens to be stored in.
 *
 * The indexed exact match answers virtually every call, because new rows are
 * normalised on the way in and the migration lowercased what was already there.
 * The second query is for the rows the migration had to leave alone: two
 * addresses differing only by case cannot both become lowercase, so they keep
 * their original spelling until somebody decides which is which, and until then
 * their owners still have to be able to log in.
 *
 * Oldest first, so which account answers is at least fixed rather than whatever
 * the database felt like returning. `npm run check:emails` reports any pair in
 * that state, since the newer of the two is effectively locked out until it is
 * merged by hand.
 */
export async function findUserByEmail(email: string) {
  const exact = await prisma.user.findUnique({ where: { email } });
  if (exact) return exact;

  return prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Rewrites a legacy address to lowercase once its owner has proved they own it,
 * so the fallback lookup above gets rarer on its own.
 *
 * Best effort on purpose. If the lowercase spelling belongs to a different row
 * this loses to the unique index, which is the right outcome: two accounts must
 * not be merged behind anybody's back.
 */
export async function adoptLowercaseEmail(id: string, stored: string): Promise<void> {
  const normalized = normalizeEmail(stored);
  if (normalized === stored) return;

  await prisma.user.update({ where: { id }, data: { email: normalized } }).catch(() => undefined);
}
