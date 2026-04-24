import express from 'express';
import crypto from 'crypto';
import { requireUser, attachUser } from '../auth/middleware.js';
import {
  buildAuthUrl,
  connectUserFromCode,
  disconnect,
  isConfigured,
} from '../integrations/googleCalendar.js';
import { createState, consumeState, getTokens } from '../db/repos/googleTokens.js';

const router = express.Router();

router.get('/status', requireUser, (req, res) => {
  const tokens = getTokens(req.user.id);
  res.json({
    configured: isConfigured(),
    linked: !!tokens,
    calendar_id: tokens?.calendar_id || null,
  });
});

router.get('/auth/start', requireUser, (req, res) => {
  if (!isConfigured()) {
    return res
      .status(503)
      .json({ detail: 'Google OAuth is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  createState(state, req.user.id);
  const url = buildAuthUrl(state);
  res.redirect(302, url);
});

router.get('/auth/callback', attachUser, async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) {
    return res.status(400).send(`Google auth error: ${String(error)}`);
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state.');
  }
  const userId = consumeState(String(state));
  if (!userId) return res.status(400).send('Invalid or expired state.');
  try {
    await connectUserFromCode(userId, String(code));
    res.send(
      '<!doctype html><meta charset="utf-8"><title>Calendar linked</title>' +
        '<body style="font-family:sans-serif;background:#020617;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
        '<div><h1>✅ Google Calendar linked</h1><p>You can close this tab and return to the app.</p></div>' +
        '<script>setTimeout(()=>window.close(),1200)</script></body>'
    );
  } catch (err) {
    console.error('[google-oauth] callback error:', err);
    res.status(500).send(`Failed to link calendar: ${err.message}`);
  }
});

router.post('/unlink', requireUser, (req, res) => {
  disconnect(req.user.id);
  res.json({ unlinked: true });
});

export default router;
