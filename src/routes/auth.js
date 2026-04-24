import express from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createUser, getUserByEmail, getUserById, updatePassword } from '../db/repos/users.js';
import {
  createSession,
  revokeSession,
  revokeAllForUser,
  revokeAllForUserExcept,
} from '../db/repos/sessions.js';
import { requireUser } from '../auth/middleware.js';
import { createLimiter, clientIp } from '../auth/rateLimit.js';

const router = express.Router();

const credsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});

const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  new_password: z.string().min(8).max(200),
});

const changeSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(200),
});

const resetIpLimiter = createLimiter({ max: 10, windowMs: 60 * 1000 });
const resetEmailLimiter = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const changeUserLimiter = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    signed: true,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  };
}

router.post('/signup', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      detail: 'Invalid email or password. Password must be at least 8 characters.',
    });
  }
  const { email, password } = parsed.data;
  if (getUserByEmail(email)) {
    return res.status(409).json({ detail: 'An account with that email already exists.' });
  }
  const hash = await hashPassword(password);
  const user = createUser(email, hash);
  const sid = createSession(user.id);
  res.cookie('sid', sid, cookieOptions());
  res.json({ id: user.id, email: user.email });
});

router.post('/login', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ detail: 'Invalid email or password.' });
  }
  const { email, password } = parsed.data;
  const row = getUserByEmail(email);
  if (!row) {
    return res.status(401).json({ detail: 'Invalid email or password.' });
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    return res.status(401).json({ detail: 'Invalid email or password.' });
  }
  const sid = createSession(row.id);
  res.cookie('sid', sid, cookieOptions());
  res.json({ id: row.id, email: row.email });
});

router.post('/logout', requireUser, (req, res) => {
  revokeSession(req.sessionId);
  res.clearCookie('sid', { path: '/' });
  res.json({ status: 'ok' });
});

router.get('/me', requireUser, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

router.post('/reset-password', async (req, res) => {
  const ip = clientIp(req);

  const parsed = resetSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ detail: 'Invalid email or password.' });
  }
  const { email, new_password: newPassword } = parsed.data;

  if (!resetIpLimiter.check(ip).allowed || !resetEmailLimiter.check(email).allowed) {
    return res.status(429).json({ detail: 'Too many requests' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ detail: 'No account with that email.' });
  }

  const newHash = await hashPassword(newPassword);
  updatePassword(user.id, newHash);
  revokeAllForUser(user.id);
  const sid = createSession(user.id);
  res.cookie('sid', sid, cookieOptions());

  console.info(`[auth] password_reset.succeeded user_id=${user.id} ip=${ip}`);
  res.json({ ok: true });
});

router.post('/change-password', requireUser, async (req, res) => {
  const ip = clientIp(req);

  if (!changeUserLimiter.check(req.user.id).allowed) {
    return res.status(429).json({ detail: 'Too many requests' });
  }

  const parsed = changeSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ detail: 'Invalid input' });
  }
  const { current_password: currentPassword, new_password: newPassword } = parsed.data;

  const row = getUserById(req.user.id);
  if (!row) {
    return res.status(401).json({ detail: 'Not authenticated' });
  }

  const ok = await verifyPassword(currentPassword, row.password_hash);
  if (!ok) {
    console.info(`[auth] password_change.failed reason=wrong_current user_id=${row.id} ip=${ip}`);
    return res.status(403).json({ detail: 'Current password is incorrect' });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ detail: 'New password must differ from current password' });
  }

  const newHash = await hashPassword(newPassword);
  updatePassword(row.id, newHash);

  revokeAllForUserExcept(row.id, req.sessionId);
  revokeSession(req.sessionId);
  const sid = createSession(row.id);
  res.cookie('sid', sid, cookieOptions());

  console.info(`[auth] password_change.succeeded user_id=${row.id} ip=${ip}`);
  res.json({ ok: true });
});

export default router;
