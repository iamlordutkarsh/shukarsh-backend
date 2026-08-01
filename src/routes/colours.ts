import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { handleWriteError } from "../lib/write-errors";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "A colour has to be a hex code like #1a2b3c")
  .optional()
  .nullable();

/**
 * The whole palette, in order.
 *
 * Saved as one list for the same reason a product's sizes are: reordering it is
 * one decision, and half of it applied is a palette in an order nobody chose.
 */
const paletteSchema = z.object({
  colours: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(40),
        hex,
        /** Set only for a print or a stripe that no single colour describes. */
        hex2: hex,
      })
    )
    .max(120),
});

/** Read by the admin's colour manager, which is the only thing that wants it. */
router.get("/", authenticate, requireAdmin, async (_req, res) => {
  const colours = await prisma.colourPreset.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  res.json({ colours });
});

router.put("/", authenticate, requireAdmin, async (req, res) => {
  const result = paletteSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const wanted = result.data.colours;
  const names = wanted.map((colour) => colour.name.toLowerCase());

  // The database enforces this too, but only exactly: "Navy" and "navy" would
  // both be allowed there, and two spellings of one colour is the drift this
  // palette exists to prevent.
  if (new Set(names).size !== names.length) {
    res.status(400).json({ error: "Two colours cannot have the same name." });
    return;
  }

  try {
    const colours = await prisma.$transaction(async (tx) => {
      const keptIds = new Set(wanted.map((colour) => colour.id).filter(Boolean) as string[]);

      // Nothing points at a preset, so removing one is a plain delete: the
      // products that used it keep their own copy of the name and the hex.
      await tx.colourPreset.deleteMany({
        where: keptIds.size > 0 ? { id: { notIn: [...keptIds] } } : {},
      });

      for (const [position, colour] of wanted.entries()) {
        const data = {
          name: colour.name,
          hex: colour.hex ?? null,
          hex2: colour.hex2 ?? null,
          position,
        };

        if (colour.id) await tx.colourPreset.update({ where: { id: colour.id }, data });
        else await tx.colourPreset.create({ data });
      }

      return tx.colourPreset.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] });
    });

    res.json({ colours });
  } catch (error) {
    handleWriteError(res, error, {
      duplicate: "The palette already has a colour with that name",
      fallback: "Could not save the palette",
    });
  }
});

export default router;
