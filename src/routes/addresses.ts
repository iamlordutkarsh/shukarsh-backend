import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { shippingAddressSchema } from "../lib/address";
import { authenticate } from "../middleware/auth";

const router = Router();

/**
 * Enough for a home, a parent's, an office and a few one-offs. A cap at all
 * because this is an authenticated write with no other cost to the caller.
 */
const MAX_ADDRESSES = 20;

/** The saved-address shape is the shipping one plus whether it is the default. */
const addressSchema = shippingAddressSchema.extend({ isDefault: z.boolean().default(false) });

/**
 * The first thing actually wrong with it, rather than "Invalid address".
 *
 * The client shows `error` and drops `details`, so a generic message leaves
 * somebody staring at a form with seven fields and no idea which one it objects
 * to. The schema already words these for a reader.
 */
function firstProblem(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid address";
}

const selection = {
  id: true,
  name: true,
  phone: true,
  line1: true,
  line2: true,
  city: true,
  state: true,
  zip: true,
  country: true,
  isDefault: true,
} as const;

/** Default first, then newest, which is the order the picker shows them in. */
const ordering = [{ isDefault: "desc" as const }, { createdAt: "desc" as const }];

router.use(authenticate);

router.get("/", async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.id },
    orderBy: ordering,
    select: selection,
  });

  res.json({ addresses });
});

router.post("/", async (req, res) => {
  const result = addressSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: firstProblem(result.error), details: result.error.flatten() });
    return;
  }

  const userId = req.user!.id;
  const count = await prisma.address.count({ where: { userId } });
  if (count >= MAX_ADDRESSES) {
    res.status(400).json({ error: `You can keep up to ${MAX_ADDRESSES} addresses.` });
    return;
  }

  const { isDefault, ...fields } = result.data;
  // The first one saved is the default whatever the caller said, or a customer
  // ends up with an address book where nothing is chosen.
  const shouldDefault = isDefault || count === 0;

  const address = await prisma.$transaction(async (tx) => {
    if (shouldDefault) {
      await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.address.create({
      data: { ...fields, userId, isDefault: shouldDefault },
      select: selection,
    });
  });

  res.status(201).json({ address });
});

router.put("/:id", async (req, res) => {
  const result = addressSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: firstProblem(result.error), details: result.error.flatten() });
    return;
  }

  const userId = req.user!.id;
  const id = req.params.id as string;

  // Scoped by owner, not just by id: without this, knowing an id is enough to
  // rewrite where somebody else's parcels go.
  const existing = await prisma.address.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const { isDefault, ...fields } = result.data;

  const address = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({
        where: { userId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
    }
    return tx.address.update({ where: { id }, data: { ...fields, isDefault }, select: selection });
  });

  res.json({ address });
});

router.delete("/:id", async (req, res) => {
  const userId = req.user!.id;
  const id = req.params.id as string;

  const existing = await prisma.address.findFirst({
    where: { id, userId },
    select: { id: true, isDefault: true },
  });
  if (!existing) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id } });

    // Deleting the default would otherwise leave the book with none, and the
    // checkout picker with nothing preselected.
    if (existing.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  res.json({ deleted: true });
});

export default router;
