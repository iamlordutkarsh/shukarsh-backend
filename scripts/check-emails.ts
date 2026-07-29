import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { normalizeEmail } from "../src/lib/account";

/**
 * Lists accounts whose addresses differ only by capitalisation.
 *
 * The migration lowercased everything it safely could and deliberately stopped
 * at pairs like Priya@gmail.com and priya@gmail.com, because merging two
 * accounts means choosing whose orders and password survive. That is a decision
 * for a person, so this only reports.
 *
 * Needs a database, so it is a diagnostic to run by hand rather than part of the
 * build. Silence here means the shop is clean and the unique index is holding.
 */
async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map<string, typeof users>();
  for (const user of users) {
    const key = normalizeEmail(user.email);
    const group = groups.get(key);
    if (group) group.push(user);
    else groups.set(key, [user]);
  }

  const collisions = [...groups.entries()].filter(([, group]) => group.length > 1);

  for (const [address, group] of collisions) {
    console.log(`\n${address} is held by ${group.length} accounts:`);

    for (const user of group) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "no name";
      console.log(
        `  ${user.email.padEnd(34)} ${user.role.padEnd(8)} ${user._count.orders} order(s)  ` +
          `joined ${user.createdAt.toISOString().slice(0, 10)}  ${name}  [${user.id}]`
      );
    }

    // Whoever fixes this needs to know which way round to do it: the oldest
    // account is usually the real one, but the one with orders against it always
    // wins over the one without.
    console.log("  Keep the account with the orders, move any others' orders onto it, then delete them.");
  }

  console.log(
    collisions.length === 0
      ? `\nAll ${users.length} account(s) have a distinct address. Nothing to do, and safe to add ` +
          `the unique index on lower("email") that makes this permanent.`
      : `\n${collisions.length} address(es) are held by more than one account. ` +
          `Until they are resolved, sign-in matches the oldest of each pair and the newer one ` +
          `cannot be reached.`
  );

  await prisma.$disconnect();
  process.exit(collisions.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
