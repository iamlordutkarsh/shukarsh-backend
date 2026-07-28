import { Prisma } from "@prisma/client";
import type { Response } from "express";

/**
 * Answers a write the database refused.
 *
 * Only the failures we can actually explain become a 4xx. Everything else is a
 * 500, which is the point of this: these handlers used to answer every failure
 * with the one explanation they had, so a dropped connection while saving a
 * category told the admin the slug was taken and sent them looking for a
 * duplicate that was never there.
 *
 * Pass only the outcomes a given write can really produce. An unhandled code
 * falls through to the fallback rather than borrowing someone else's message.
 */
export function handleWriteError(
  res: Response,
  error: unknown,
  outcomes: {
    /** P2002, a unique column already holds this value. */
    duplicate?: string;
    /** P2025, the row to update or delete is not there. */
    missing?: string;
    /** P2003 or P2014, a foreign key says no: either the thing it points at does not exist, or something still points here. */
    related?: string;
    /** Logged, and sent as a 500. */
    fallback: string;
  }
): void {
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;

  if (code === "P2002" && outcomes.duplicate) {
    res.status(409).json({ error: outcomes.duplicate });
    return;
  }

  if (code === "P2025" && outcomes.missing) {
    res.status(404).json({ error: outcomes.missing });
    return;
  }

  if ((code === "P2003" || code === "P2014") && outcomes.related) {
    res.status(409).json({ error: outcomes.related });
    return;
  }

  console.error(`${outcomes.fallback}:`, error);
  res.status(500).json({ error: outcomes.fallback });
}
