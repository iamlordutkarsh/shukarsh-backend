import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * How many connections this process may hold open.
 *
 * Prisma's own default is two per CPU plus one, worked out from the host rather
 * than from what the database will allow. Supabase's session pooler hands out
 * fifteen clients to the whole project, so a multi-core host reaches for more than
 * exists and the next query anywhere in the shop is refused outright. Ten leaves
 * room for migrations and for a look at the tables while the site is running.
 *
 * Set connection_limit in DATABASE_URL to overrule this.
 */
const DEFAULT_CONNECTION_LIMIT = 10;

function datasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes("connection_limit")) return undefined;

  try {
    const parsed = new URL(url);
    parsed.searchParams.set("connection_limit", String(DEFAULT_CONNECTION_LIMIT));
    return parsed.toString();
  } catch {
    // A URL the standard parser cannot read is one to leave alone: the driver is
    // stricter about some shapes than we are, and a broken guess here would take
    // the whole shop down rather than one page.
    return undefined;
  }
}

function createClient(): PrismaClient {
  const url = datasourceUrl();
  return url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
