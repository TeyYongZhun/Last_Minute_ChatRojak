import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { parseMessages } from './modules/task1Parser.js';
import {
  mergeNewTasks,
  replanAll,
  startTask,
  completeTask,
  respondToClarification,
  toggleStep,
  getDashboard,
  resetUser,
} from './modules/task3Executor.js';
import { seedDemo } from './modules/demoSeed.js';
import { startTelegramBot, isBotEnabled } from './modules/telegramBot.js';
import { processWithEvents } from './modules/processStream.js';
import { getProviderName, MODEL } from './client.js';
import { runMigrations } from './db/migrate.js';
import { startScheduler } from './scheduler.js';
import authRouter from './routes/auth.js';
import telegramRouter from './routes/telegram.js';
import { requireUser } from './auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'static');

const app = express();

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.warn('[server] WARNING: SESSION_SECRET not set — generating an ephemeral secret; sessions will not survive restart.');
}
app.use(cookieParser(sessionSecret || crypto.randomBytes(32).toString('hex')));
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(STATIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.use('/api/auth', authRouter);
app.use('/api/telegram', telegramRouter);

function parseFilters(query) {
  const filters = {};
  if (typeof query.category === 'string' && query.category.trim()) filters.category = query.category.trim();
  if (typeof query.priority === 'string' && ['high', 'medium', 'low'].includes(query.priority)) {
    filters.priority = query.priority;
  }
  if (typeof query.status === 'string' && query.status.trim()) filters.status = query.status.trim();
  if (typeof query.q === 'string' && query.q.trim()) filters.q = query.q.trim();
  if (typeof query.tags === 'string' && query.tags.trim()) {
    filters.tags = query.tags.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return filters;
}

app.post('/api/process', requireUser, async (req, res) => {
  const text = req.body?.text;
  if (!text || !text.trim()) {
    return res.status(400).json({ detail: 'No text provided' });
  }
  try {
    const now = new Date();
    const tasks = await parseMessages(text, now);
    if (!tasks.length) {
      return res.json({
        tasks_extracted: 0,
        plans_created: 0,
        conflicts: 0,
        message: 'No actionable tasks found',
      });
    }
    mergeNewTasks(req.user.id, tasks);
    const replan = await replanAll(req.user.id, now);
    res.json({
      tasks_extracted: tasks.length,
      plans_created: replan.plans.length,
      conflicts: replan.conflicts.length,
    });
  } catch (e) {
    console.error('[/api/process] error:', e);
    res.status(500).json({ detail: e.message || 'Internal server error' });
  }
});

app.post('/api/process-stream', requireUser, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ detail: 'No text provided' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = (kind, data) => {
    res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    await processWithEvents(req.user.id, text, new Date(), emit);
  } catch (e) {
    console.error('[/api/process-stream] error:', e);
    emit('error', { message: e.message || 'Processing failed' });
  } finally {
    res.end();
  }
});

app.get('/api/dashboard', requireUser, (req, res) => {
  res.json(getDashboard(req.user.id, parseFilters(req.query)));
});

app.post('/api/tasks/:taskId/start', requireUser, (req, res) => {
  if (!startTask(req.user.id, req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ status: 'in_progress' });
});

app.post('/api/tasks/:taskId/complete', requireUser, async (req, res) => {
  if (!completeTask(req.user.id, req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  try {
    await replanAll(req.user.id, new Date());
  } catch (e) {
    console.error('[/api/tasks/:id/complete] replan error:', e);
  }
  res.json({ status: 'done' });
});

app.post('/api/tasks/:taskId/step', requireUser, (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number') {
    return res.status(400).json({ detail: 'index (number) is required' });
  }
  if (!toggleStep(req.user.id, req.params.taskId, index)) {
    return res.status(404).json({ detail: 'Task or step not found' });
  }
  res.json({ status: 'toggled' });
});

app.post('/api/clarify', requireUser, async (req, res) => {
  const { task_id, field, value } = req.body || {};
  if (!task_id || !field || value == null) {
    return res.status(400).json({ detail: 'task_id, field, value are required' });
  }
  if (!respondToClarification(req.user.id, task_id, field, value)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  try {
    await replanAll(req.user.id, new Date());
    res.json({ status: 'updated' });
  } catch (e) {
    console.error('[/api/clarify] replan error:', e);
    res.status(500).json({ detail: e.message });
  }
});

app.post('/api/reset', requireUser, (req, res) => {
  resetUser(req.user.id);
  res.json({ status: 'reset' });
});

app.post('/api/demo-seed', requireUser, (req, res) => {
  seedDemo(req.user.id);
  res.json({ status: 'seeded' });
});

export function createApp() {
  return app;
}

const PORT = Number(process.env.PORT) || 8000;

if (process.env.NODE_ENV !== 'test' && !process.env.SKIP_SERVER_START) {
  runMigrations();
  app.listen(PORT, () => {
    const provider = getProviderName();
    console.log(`Last Minute ChatRojak running at http://localhost:${PORT}`);
    console.log(`AI provider: ${provider} · model: ${MODEL}`);
    const keyEnv = provider === 'gemini' ? 'GEMINI_API_KEY' : 'Z_AI_API_KEY';
    if (!process.env[keyEnv]) {
      console.warn(`WARNING: ${keyEnv} not set. Copy .env.example to .env and add your key.`);
    }
    if (isBotEnabled()) startTelegramBot();
    startScheduler();
  });
}
