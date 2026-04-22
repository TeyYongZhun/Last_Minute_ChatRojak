import express from 'express';
import { requireUser } from '../auth/middleware.js';
import { issueLinkCode, getChatIdForUser } from '../db/repos/telegram.js';
import { isBotEnabled } from '../modules/telegramBot.js';

const router = express.Router();

router.get('/status', requireUser, (req, res) => {
  res.json({
    bot_enabled: isBotEnabled(),
    linked_chat_id: getChatIdForUser(req.user.id),
  });
});

router.post('/link-code', requireUser, (req, res) => {
  if (!isBotEnabled()) {
    return res.status(503).json({ detail: 'Telegram bot is not configured on this server.' });
  }
  const code = issueLinkCode(req.user.id);
  res.json({ code, expires_in_seconds: 600 });
});

export default router;
