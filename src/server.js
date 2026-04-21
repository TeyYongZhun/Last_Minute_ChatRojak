import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseMessages } from './modules/task1Parser.js';
import { planTasks } from './modules/task2Planner.js';
import {
  mergeTasksAndPlans,
  completeTask,
  respondToClarification,
  getDashboard,
} from './modules/task3Executor.js';
import { clearState, loadState } from './state.js';

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
    const { plans, conflicts } = await planTasks(tasks, now);
    mergeTasksAndPlans(tasks, plans, conflicts);
    res.json({
      tasks_extracted: tasks.length,
      plans_created: plans.length,
      conflicts: conflicts.length,
    });
  } catch (e) {
    console.error('[/api/process] error:', e);
    res.status(500).json({ detail: e.message || 'Internal server error' });
  }
});

app.get('/api/dashboard', (_req, res) => {
  res.json(getDashboard());
});

app.post('/api/tasks/:taskId/complete', (req, res) => {
  if (!completeTask(req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ status: 'done' });
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
    const state = loadState();
    const affected = state.tasks.filter((t) => t.id === task_id);
    if (affected.length) {
      const { plans, conflicts } = await planTasks(affected, new Date());
      mergeTasksAndPlans(affected, plans, conflicts);
    }
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

const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, () => {
  console.log(`Last Minute ChatRojak running at http://localhost:${PORT}`);
  if (!process.env.Z_AI_API_KEY) {
    console.warn('WARNING: Z_AI_API_KEY not set. Copy .env.example to .env and add your key.');
  }
});
