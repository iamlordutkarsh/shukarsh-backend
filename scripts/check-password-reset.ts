import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { consumeResetToken, issueResetToken } from "../src/lib/password-reset";

/**
 * Proves the four claims a reset token makes about itself.
 *
 * Every one of them needs a database — the guarantees live in unique indexes and
 * conditional updates, not in arithmetic — so this is a diagnostic to run by
 * hand rather than part of the build, the same as `check:stock`.
 *
 * Runs against a throwaway user it creates and deletes, so it is safe to point
 * at any database including production. Nothing else is written.
 */

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

async function main() {
  const email = `reset-check-${Date.now()}@example.invalid`;
  const user = await prisma.user.create({
    data: { email, password: "not-a-real-hash" },
    select: { id: true },
  });

  try {
    const token = await issueResetToken(user.id);

    check("a fresh token names its account", (await consumeResetToken(token)) === user.id);

    check(
      "the same token cannot be spent twice",
      (await consumeResetToken(token)) === null,
      "a used link still worked"
    );

    check("a token that was never issued is refused", (await consumeResetToken("not-a-token")) === null);

    check("an empty token is refused", (await consumeResetToken("")) === null);

    // Asking again must retire whatever was outstanding, or a link mailed an
    // hour ago still opens the account after the customer asked for a new one.
    const first = await issueResetToken(user.id);
    const second = await issueResetToken(user.id);
    check(
      "asking again retires the previous link",
      (await consumeResetToken(first)) === null,
      "the superseded link still worked"
    );
    check("the newest link is the one that works", (await consumeResetToken(second)) === user.id);

    // Expiry is stored, not computed at read time, so it can be aged directly.
    const stale = await issueResetToken(user.id);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    check(
      "an expired link is refused",
      (await consumeResetToken(stale)) === null,
      "a link past its expiry still worked"
    );
  } finally {
    // Cascades to the tokens.
    await prisma.user.delete({ where: { id: user.id } });
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(
    failed === 0
      ? `\nAll ${results.length} checks passed.`
      : `\n${failed} of ${results.length} checks failed.`
  );

  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
