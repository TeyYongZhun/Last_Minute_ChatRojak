import './load-env.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  mergeNewTasks,
  replanAll,
  startTask,
  completeTask,
  pauseTask,
  respondToClarification,
  setUserEisenhower,
  setUserDurationMinutes,
  setUserPriority,
  setBucket,
  addTaskDependency,
  removeTaskDependency,
  toggleStep,
  getDashboard,
  getTimeline,
  resetUser,
  renameCategory,
  applyDependencies,
} from './modules/task3Executor.js';
import { runChain } from './modules/promptChain.js';
import { startTelegramBot, isBotEnabled } from './modules/telegramBot.js';
import { processWithEvents } from './modules/processStream.js';
import { getProviderName, getProviderKeyEnv, MODEL } from './client.js';
import { runMigrations } from './db/migrate.js';
import { startScheduler } from './scheduler.js';
import authRouter from './routes/auth.js';
import telegramRouter from './routes/telegram.js';
import googleOAuthRouter from './routes/googleOAuth.js';
import { requireUser } from './auth/middleware.js';
import { getTask, setCalendarSyncEnabled } from './db/repos/tasks.js';
import { getPlan } from './db/repos/plans.js';
import { getTokens as getGoogleTokens } from './db/repos/googleTokens.js';
import { upsertEvent as upsertCalendarEvent, deleteEvent as deleteCalendarEvent } from './integrations/googleCalendar.js';
import { addTaskEvent } from './db/repos/taskEvents.js';
import { updateChecklistItemText } from './db/repos/checklists.js';
import { listOpenThreads, receive as receiveClarification } from './modules/clarificationLoop.js';
import { reset as resetAdaptation, weightsSummary } from './modules/adaptiveScoring.js';

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
app.use('/api/google', googleOAuthRouter);

function parseFilters(query) {
  const filters = {};
  if (typeof query.bucket === 'string' && query.bucket.trim()) filters.bucket = query.bucket.trim();
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
  const { text, timeframe = 'all' } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ detail: 'No text provided' });
  }
  try {
    const now = new Date();
    const chain = await runChain(req.user.id, text, now, { timeframe });
    if (!chain.tasks.length) {
      return res.json({
        tasks_extracted: 0,
        plans_created: 0,
        conflicts: 0,
        validation: chain.validation,
        message: 'No actionable tasks found',
      });
    }
    const idMap = mergeNewTasks(req.user.id, chain.tasks);
    if (chain.dependencies?.length) {
      applyDependencies(req.user.id, chain.dependencies, idMap);
    }
    const replan = await replanAll(req.user.id, now);
    res.json({
      tasks_extracted: chain.tasks.length,
      plans_created: replan.plans.length,
      conflicts: replan.conflicts.length,
      validation: chain.validation,
      degraded: chain.degraded,
    });
  } catch (e) {
    console.error('[/api/process] error:', e);
    res.status(500).json({ detail: e.message || 'Internal server error' });
  }
});

app.post('/api/process-stream', requireUser, async (req, res) => {
  const { text: rawText, timeframe = 'all' } = req.body || {};
  const text = (rawText || '').trim();
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
    await processWithEvents(req.user.id, text, new Date(), emit, timeframe);
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

app.post('/api/demo-seed', requireUser, (req, res) => {
  const tasks = [
    {
      id: 't1',
      task: 'Submit assignment',
      deadline: null,
      deadline_iso: null,
      assigned_by: 'Professor',
      priority: 'high',
      confidence: 0.95,
      category: 'Academic',
      missing_fields: [],
      status: 'pending',
      tags: ['urgent', 'solo'],
    },
    {
      id: 't2',
      task: 'Help with lab report',
      deadline: null,
      deadline_iso: null,
      assigned_by: 'Tutor',
      priority: 'medium',
      confidence: 0.9,
      category: 'Academic',
      missing_fields: [],
      status: 'pending',
      tags: ['group-work', 'short'],
    },
    {
      id: 't3',
      task: 'Buy groceries',
      deadline: null,
      deadline_iso: null,
      assigned_by: null,
      priority: 'low',
      confidence: 0.8,
      category: 'Errand',
      missing_fields: [],
      status: 'pending',
      tags: ['short', 'solo'],
    },
  ];

  const current = getDashboard(req.user.id).total_tasks;
  if (!current) {
    mergeNewTasks(req.user.id, tasks);
  }
  res.json({ seeded: true, total_tasks: getDashboard(req.user.id).total_tasks });
});

app.post('/api/tasks/:taskId/start', requireUser, (req, res) => {
  const out = startTask(req.user.id, req.params.taskId);
  switch (out.result) {
    case 'ok':
      return res.json({ status: 'in_progress' });
    case 'already_started':
      return res.json({ status: 'in_progress', already_started: true });
    case 'not_found':
      return res.status(404).json({ detail: 'Task not found' });
    case 'done':
      return res.status(409).json({ detail: 'Task is already completed', reason: 'done' });
    case 'blocked':
      return res.status(409).json({
        detail: 'Task is blocked — clarification needed before it can be started',
        reason: 'blocked_waiting_info',
        missing_fields: out.missing_fields || [],
      });
    case 'blocked_by_deps':
      return res.status(409).json({
        detail: 'Task is waiting on unfinished prerequisites',
        reason: 'blocked_by_deps',
        depends_on: out.depends_on || [],
      });
    default:
      return res.status(500).json({ detail: 'Unknown start result' });
  }
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

app.post('/api/tasks/:taskId/pause', requireUser, async (req, res) => {
  const out = pauseTask(req.user.id, req.params.taskId);
  switch (out.result) {
    case 'ok':
      try { await replanAll(req.user.id, new Date()); } catch (e) { console.error('[/api/tasks/:id/pause] replan error:', e); }
      return res.json({ status: 'pending' });
    case 'not_found':
      return res.status(404).json({ detail: 'Task not found' });
    case 'already_done':
      return res.status(409).json({ detail: 'Task is already completed', reason: 'done' });
    case 'not_in_progress':
      return res.status(409).json({ detail: 'Task is not in progress', reason: 'not_in_progress' });
    default:
      return res.status(500).json({ detail: 'Unknown pause result' });
  }
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

app.post('/api/tasks/:taskId/step-text', requireUser, (req, res) => {
  const { index, text } = req.body || {};
  if (typeof index !== 'number') {
    return res.status(400).json({ detail: 'index (number) is required' });
  }
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return res.status(400).json({ detail: 'text is required' });
  }
  if (trimmed.length > 500) {
    return res.status(400).json({ detail: 'text must be 500 characters or fewer' });
  }
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  const changes = updateChecklistItemText(req.params.taskId, index, trimmed);
  if (!changes) return res.status(404).json({ detail: 'Step not found' });
  res.json({ status: 'updated' });
});

app.post('/api/tasks/:taskId/eisenhower', requireUser, async (req, res) => {
  const { quadrant } = req.body || {};
  const allowed = [null, 'do', 'plan', 'quick', 'later'];
  if (!allowed.includes(quadrant)) {
    return res.status(400).json({ detail: 'quadrant must be do, plan, quick, later, or null' });
  }
  if (!setUserEisenhower(req.user.id, req.params.taskId, quadrant)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/duration', requireUser, async (req, res) => {
  const raw = req.body?.minutes;
  const minutes = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (minutes !== null && (!isFinite(minutes) || minutes < 5 || minutes > 1440)) {
    return res.status(400).json({ detail: 'minutes must be null or a number between 5 and 1440' });
  }
  if (!setUserDurationMinutes(req.user.id, req.params.taskId, minutes)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/priority', requireUser, (req, res) => {
  const { priority } = req.body || {};
  const allowed = [null, 'high', 'medium', 'low'];
  if (!allowed.includes(priority ?? null)) {
    return res.status(400).json({ detail: 'priority must be high, medium, low, or null' });
  }
  if (!setUserPriority(req.user.id, req.params.taskId, priority ?? null)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/bucket', requireUser, (req, res) => {
  const { bucket } = req.body || {};
  if (!bucket || typeof bucket !== 'string') {
    return res.status(400).json({ detail: 'bucket (string) is required' });
  }
  if (!setBucket(req.user.id, req.params.taskId, bucket)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/dependencies', requireUser, async (req, res) => {
  const { depends_on, reason } = req.body || {};
  if (!depends_on) return res.status(400).json({ detail: 'depends_on required' });
  const { ok, error, code } = addTaskDependency(req.user.id, req.params.taskId, depends_on, reason || null);
  if (!ok) {
    const status = code === 'CYCLE' ? 409 : 400;
    return res.status(status).json({ detail: error });
  }
  try {
    await replanAll(req.user.id, new Date());
  } catch (e) {
    console.error('[/api/tasks/:id/dependencies] replan error:', e);
  }
  res.json({ ok: true });
});

app.delete('/api/tasks/:taskId/dependencies/:dep', requireUser, async (req, res) => {
  const changed = removeTaskDependency(req.user.id, req.params.taskId, req.params.dep);
  if (!changed) return res.status(404).json({ detail: 'Dependency not found' });
  try {
    await replanAll(req.user.id, new Date());
  } catch (e) {
    console.error('[/api/tasks/:id/dependencies] replan error:', e);
  }
  res.json({ ok: true });
});

app.get('/api/tasks/:taskId/timeline', requireUser, (req, res) => {
  const tl = getTimeline(req.user.id, req.params.taskId, 100);
  if (!tl) return res.status(404).json({ detail: 'Task not found' });
  res.json({ events: tl });
});

app.get('/api/clarifications', requireUser, (req, res) => {
  res.json({ threads: listOpenThreads(req.user.id) });
});

app.post('/api/clarifications/:threadId/answer', requireUser, async (req, res) => {
  const { answer } = req.body || {};
  if (!answer) return res.status(400).json({ detail: 'answer required' });
  const resolved = receiveClarification(req.params.threadId, String(answer), {
    onResolve: (thread, value) => {
      respondToClarification(thread.user_id, thread.task_id, thread.field, value);
    },
  });
  if (!resolved) return res.status(404).json({ detail: 'Thread not found or already closed' });
  try {
    await replanAll(req.user.id, new Date());
  } catch (e) {
    console.error('[/api/clarifications/answer] replan error:', e);
  }
  res.json({ ok: true });
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

app.post('/api/replan', requireUser, async (req, res) => {
  try {
    const result = await replanAll(req.user.id, new Date());
    res.json({
      plans_created: result.plans.length,
      conflicts: result.conflicts.length,
    });
  } catch (e) {
    console.error('[/api/replan] error:', e);
    res.status(500).json({ detail: e.message || 'Replan failed' });
  }
});

app.post('/api/rename-category', requireUser, (req, res) => {
  const { old_name, new_name } = req.body || {};
  if (!old_name || !new_name) {
    return res.status(400).json({ detail: 'old_name and new_name are required' });
  }
  const changed = renameCategory(req.user.id, old_name, new_name);
  res.json({ changed });
});

app.get('/api/adaptation', requireUser, (req, res) => {
  res.json({ summary: weightsSummary(req.user.id) });
});

app.post('/api/adaptation/reset', requireUser, (req, res) => {
  resetAdaptation(req.user.id);
  res.json({ ok: true });
});

app.post('/api/reset', requireUser, (req, res) => {
  resetUser(req.user.id);
  res.json({ status: 'reset' });
});

app.post('/api/tasks/:taskId/calendar-sync', requireUser, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ detail: 'enabled must be boolean' });
  }
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });

  if (!enabled) {
    setCalendarSyncEnabled(req.user.id, task.id, 0);
    addTaskEvent(req.user.id, task.id, 'calendar_sync_toggled', { enabled: false });
    try {
      await deleteCalendarEvent(req.user.id, task.id);
    } catch (err) {
      console.error('[/api/tasks/:id/calendar-sync] delete error:', err.message);
    }
    return res.json({ ok: true, enabled: false });
  }

  if (!getGoogleTokens(req.user.id)) {
    return res.status(409).json({ detail: 'Google Calendar not linked' });
  }

  setCalendarSyncEnabled(req.user.id, task.id, 1);
  addTaskEvent(req.user.id, task.id, 'calendar_sync_toggled', { enabled: true });

  const fresh = getTask(req.user.id, task.id);
  const plan = getPlan(req.user.id, task.id);
  try {
    const result = await upsertCalendarEvent(req.user.id, fresh, plan, new Date());
    return res.json({
      ok: true,
      enabled: true,
      event_id: result?.event_id,
      skipped: result?.skipped ? true : undefined,
      reason: result?.reason,
      error: result?.error,
    });
  } catch (err) {
    console.error('[/api/tasks/:id/calendar-sync] upsert error:', err.message);
    return res.status(500).json({ detail: err.message || 'Calendar sync failed' });
  }
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
    const keyEnv = getProviderKeyEnv();
    if (!process.env[keyEnv]) {
      console.warn(`WARNING: ${keyEnv} not set. Copy .env.example to .env and add your key.`);
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      console.warn('[server] Google Calendar OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable calendar sync.');
    }
    if (isBotEnabled()) startTelegramBot();
    startScheduler();
  });
}
