import { Router } from "express";
import { z } from "zod";
import { emailField } from "../lib/account";
import { prisma } from "../lib/prisma";

const router = Router();

const subscribeSchema = z.object({
  email: emailField,
});

router.post("/", async (req, res) => {
  const result = subscribeSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Please enter a valid email address" });
    return;
  }

  const { email } = result.data;

  try {
    await prisma.newsletterSubscriber.upsert({
      where: { email },
      update: {},
      create: { email },
    });
    res.status(201).json({ message: "Subscribed" });
  } catch (error) {
    console.error("Newsletter subscribe failed", error);
    res.status(500).json({ error: "Could not subscribe right now" });
  }
});

export default router;
