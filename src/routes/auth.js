import express from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createUser, getUserByEmail } from '../db/repos/users.js';
import { createSession, revokeSession } from '../db/repos/sessions.js';
import { requireUser } from '../auth/middleware.js';

const router = express.Router();

const credsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});

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

export default router;
