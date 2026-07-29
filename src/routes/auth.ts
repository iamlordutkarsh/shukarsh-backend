import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { adoptLowercaseEmail, emailField, findUserByEmail } from "../lib/account";
import { hashPassword, verifyPassword, generateToken } from "../lib/auth";
import { authenticate } from "../middleware/auth";
import { loginLimiter, registerLimiter } from "../middleware/rate-limit";

const router = Router();

const registerSchema = z.object({
  email: emailField,
  password: z.string().min(6),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1),
});

router.post("/register", registerLimiter, async (req, res) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { email, password, firstName, lastName } = result.data;

  // Insensitive, so a legacy Priya@gmail.com blocks a second priya@gmail.com
  // rather than being quietly joined by it.
  const existing = await findUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashPassword(password),
      firstName,
      lastName,
    },
    select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
  });

  const token = generateToken({ id: user.id, email: user.email, role: user.role });

  res.status(201).json({ user, token });
});

router.post("/login", loginLimiter, async (req, res) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Invalid input", details: result.error.flatten() });
    return;
  }

  const { email, password } = result.data;

  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // They have just proved the address is theirs, so this is the safe moment to
  // tidy a legacy capitalisation. Not awaited: it must never delay a login.
  void adoptLowercaseEmail(user.id, user.email);

  const token = generateToken({ id: user.id, email, role: user.role });

  res.json({
    user: {
      id: user.id,
      email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
    token,
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

/**
 * Rate limited with the sign in bucket, since proving the current password is
 * the same guessing game as signing in, just behind a token.
 */
router.post("/change-password", authenticate, loginLimiter, async (req, res) => {
  const result = changePasswordSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "Your new password needs at least 6 characters" });
    return;
  }

  const { currentPassword, newPassword } = result.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!verifyPassword(currentPassword, user.password)) {
    res.status(401).json({ error: "That is not your current password" });
    return;
  }

  if (verifyPassword(newPassword, user.password)) {
    res.status(400).json({ error: "Your new password is the same as the old one" });
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { password: hashPassword(newPassword) } });

  res.json({ message: "Password changed" });
});

router.get("/me", authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ user });
});

export default router;
