import 'dotenv/config';
import express from 'express';
import path from 'path';
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
} from './modules/task3Executor.js';
import { clearState } from './state.js';
import { seedDemo } from './modules/demoSeed.js';
import { startTelegramBot, isBotEnabled, getActiveChatId } from './modules/telegramBot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'static');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(STATIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.post('/api/process', async (req, res) => {
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
    mergeNewTasks(tasks);
    const replan = await replanAll(now);
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

app.get('/api/dashboard', (_req, res) => {
  res.json(getDashboard());
});

app.post('/api/tasks/:taskId/start', (req, res) => {
  if (!startTask(req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ status: 'in_progress' });
});

app.post('/api/tasks/:taskId/complete', async (req, res) => {
  if (!completeTask(req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  try {
    await replanAll(new Date());
  } catch (e) {
    console.error('[/api/tasks/:id/complete] replan error:', e);
  }
  res.json({ status: 'done' });
});

app.post('/api/tasks/:taskId/step', (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number') {
    return res.status(400).json({ detail: 'index (number) is required' });
  }
  if (!toggleStep(req.params.taskId, index)) {
    return res.status(404).json({ detail: 'Task or step not found' });
  }
  res.json({ status: 'toggled' });
});

app.post('/api/clarify', async (req, res) => {
  const { task_id, field, value } = req.body || {};
  if (!task_id || !field || value == null) {
    return res.status(400).json({ detail: 'task_id, field, value are required' });
  }
  if (!respondToClarification(task_id, field, value)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  try {
    await replanAll(new Date());
    res.json({ status: 'updated' });
  } catch (e) {
    console.error('[/api/clarify] replan error:', e);
    res.status(500).json({ detail: e.message });
  }
});

app.post('/api/reset', (_req, res) => {
  clearState();
  res.json({ status: 'reset' });
});

app.post('/api/demo-seed', (_req, res) => {
  clearState();
  seedDemo();
  res.json({ status: 'seeded' });
});

app.get('/api/telegram-status', (_req, res) => {
  res.json({
    connected: isBotEnabled(),
    active_chat_id: getActiveChatId(),
  });
});

const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, () => {
  console.log(`Last Minute ChatRojak running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY not set. Copy .env.example to .env and add your key.');
  }
});
