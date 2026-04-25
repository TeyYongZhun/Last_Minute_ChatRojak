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
  uncompleteTask,
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
import { getTask, setCalendarSyncEnabled, deleteTask, updateTaskField, setAiSuggestion } from './db/repos/tasks.js';
import { getPlan, upsertPlan } from './db/repos/plans.js';
import { getTokens as getGoogleTokens } from './db/repos/googleTokens.js';
import { upsertEvent as upsertCalendarEvent, deleteEvent as deleteCalendarEvent } from './integrations/googleCalendar.js';
import { addTaskEvent } from './db/repos/taskEvents.js';
import { addChecklistItem, updateChecklistItemText, deleteChecklistItem, toggleChecklistItem, getChecklist, replaceChecklist } from './db/repos/checklists.js';
import { generateStepsForTask } from './modules/stepGenerator.js';
import { parseClarificationDeadline } from './modules/deadlineParser.js';
import { suggestCalendarForTask } from './modules/calendarSuggester.js';
import { listOpenThreads, receive as receiveClarification } from './modules/clarificationLoop.js';
import { reset as resetAdaptation, weightsSummary } from './modules/adaptiveScoring.js';
import { getPreferences, upsertPreferences } from './db/repos/userPreferences.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'static');

const app = express();

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.warn('[server] WARNING: SESSION_SECRET not set — generating an ephemeral secret; sessions will not survive restart.');
}
app.use(cookieParser(sessionSecret || crypto.randomBytes(32).toString('hex')));
app.use(express.json({ limit: '5mb' }));
app.use('/static', express.static(STATIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.use('/api/auth', authRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/google', googleOAuthRouter);

function parseFilters(query) {
  const filters = {};
  if (typeof query.category === 'string' && query.category.trim()) filters.category = query.category.trim();
  if (typeof query.priority === 'string' && ['high', 'medium', 'low'].includes(query.priority)) {
    filters.priority = query.priority;
  }
  const rawTags = [];
  if (Array.isArray(query.tags)) {
    for (const item of query.tags) rawTags.push(...String(item || '').split(','));
  } else if (typeof query.tags === 'string') {
    rawTags.push(...query.tags.split(','));
  }
  const tags = rawTags.map((t) => t.trim()).filter(Boolean);
  if (tags.length) filters.tags = tags;
  if (typeof query.status === 'string' && query.status.trim()) filters.status = query.status.trim();
  if (typeof query.q === 'string' && query.q.trim()) filters.q = query.q.trim();
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
    const { idMap } = mergeNewTasks(req.user.id, chain.tasks);
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

app.post('/api/demo-seed', requireUser, async (req, res) => {
  const { force } = req.body || {};
  const current = getDashboard(req.user.id).total_tasks;
  if (current && !force) {
    return res.json({ seeded: false, total_tasks: current, message: 'Already has tasks — pass force:true to reset' });
  }
  if (force) resetUser(req.user.id);

  const now = new Date();
  const iso = (days, h = 23, m = 59) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const dl = (days, h = 23, m = 59) => {
    if (days === 0) return `Today ${h}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
    if (days === 1) return 'Tomorrow 11:59pm';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const d = new Date(now); d.setDate(d.getDate() + days);
    return `${names[d.getDay()]} 11:59pm`;
  };

  const tasks = [
    {
      id: 't1', task: 'Submit CS2103T Individual Project',
      deadline: dl(1), deadline_iso: iso(1),
      assigned_by: 'Prof Leong', priority: 'high', confidence: 0.97,
      category: 'Academic', tags: ['urgent', 'solo'], estimated_duration_minutes: 120, missing_fields: [], status: 'pending',
    },
    {
      id: 't2', task: 'Prepare slides for group presentation on Thursday',
      deadline: dl(3), deadline_iso: iso(3),
      assigned_by: 'Group Leader', priority: 'high', confidence: 0.9,
      category: 'Academic', tags: ['group-work'], estimated_duration_minutes: 90, missing_fields: [], status: 'pending',
    },
    {
      id: 't3', task: 'Reply to HR email about internship offer',
      deadline: null, deadline_iso: null,
      assigned_by: 'HR', priority: 'medium', confidence: 0.88,
      category: 'Admin', tags: ['quick'], estimated_duration_minutes: 15, missing_fields: ['deadline'], status: 'pending',
    },
    {
      id: 't4', task: 'Buy groceries and cook dinner',
      deadline: dl(0, 19, 0), deadline_iso: iso(0, 19, 0),
      assigned_by: null, priority: 'low', confidence: 0.8,
      category: 'Errand', tags: ['errand'], estimated_duration_minutes: 45, missing_fields: [], status: 'pending',
    },
    {
      id: 't5', task: 'Plan CCA orientation activities for next semester',
      deadline: dl(10), deadline_iso: iso(10),
      assigned_by: 'CCA President', priority: 'medium', confidence: 0.85,
      category: 'CCA', estimated_duration_minutes: 60, missing_fields: [], status: 'pending',
    },
    {
      id: 't6', task: 'Read ST2334 lecture notes for midterm revision',
      deadline: dl(6), deadline_iso: iso(6),
      assigned_by: null, priority: 'medium', confidence: 0.92,
      category: 'Academic', estimated_duration_minutes: 60, missing_fields: [], status: 'pending',
    },
    {
      id: 't7', task: 'Register for career fair next week',
      deadline: null, deadline_iso: null,
      assigned_by: 'Career Office', priority: 'medium', confidence: 0.85,
      category: 'Admin', estimated_duration_minutes: 15, missing_fields: ['deadline'], status: 'pending',
    },
    {
      id: 't8', task: 'Draft thank-you note to internship mentor',
      deadline: dl(5, 18, 0), deadline_iso: iso(5, 18, 0),
      assigned_by: null, priority: 'low', confidence: 0.8,
      category: 'Personal', estimated_duration_minutes: 10, missing_fields: ['assigned_by'], status: 'pending',
    },
  ];

  const { idMap } = mergeNewTasks(req.user.id, tasks);
  const rid = (key) => idMap[key] || key;

  setUserEisenhower(req.user.id, rid('t1'), 'do');
  setUserEisenhower(req.user.id, rid('t2'), 'plan');
  setUserEisenhower(req.user.id, rid('t3'), 'quick');
  setUserEisenhower(req.user.id, rid('t4'), 'later');
  setUserEisenhower(req.user.id, rid('t5'), 'plan');
  setUserEisenhower(req.user.id, rid('t6'), 'plan');

  const checklists = {
    t1: [
      { text: 'Read the assignment brief carefully', done: true },
      { text: 'Complete Part 1: Class diagram', done: true },
      { text: 'Complete Part 2: Sequence diagram', done: false },
      { text: 'Write JUnit tests', done: false },
      { text: 'Submit on LumiNUS before deadline', done: false },
    ],
    t2: [
      { text: 'Outline slide structure with team', done: true },
      { text: 'Create introduction and background slides', done: false },
      { text: 'Add methodology and results slides', done: false },
      { text: 'Practice run with group', done: false },
    ],
    t5: [
      { text: 'Brainstorm activity ideas', done: false },
      { text: 'Draft event schedule', done: false },
      { text: 'Get advisor approval', done: false },
    ],
  };

  for (const [key, steps] of Object.entries(checklists)) {
    const taskId = rid(key);
    for (const s of steps) addChecklistItem(taskId, s.text);
    steps.forEach((s, pos) => { if (s.done) toggleChecklistItem(taskId, pos); });
  }

  const demoPlans = [
    { key: 't1', score: 95, decision: 'do_now'   },
    { key: 't2', score: 75, decision: 'schedule'  },
    { key: 't3', score: 60, decision: 'schedule'  },
    { key: 't4', score: 40, decision: 'defer'     },
    { key: 't5', score: 50, decision: 'schedule'  },
    { key: 't6', score: 55, decision: 'schedule'  },
    { key: 't7', score: 45, decision: 'defer'     },
    { key: 't8', score: 30, decision: 'defer'     },
  ];
  for (const p of demoPlans) {
    upsertPlan(req.user.id, {
      task_id: rid(p.key),
      priority_score: p.score,
      decision: p.decision,
      steps: [],
      conflicts: [],
      missing_info_questions: [],
      status: 'pending',
    });
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

app.post('/api/tasks/:taskId/complete', requireUser, (req, res) => {
  if (!completeTask(req.user.id, req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found' });
  }
  res.json({ status: 'done' });
});

app.post('/api/tasks/:taskId/uncomplete', requireUser, (req, res) => {
  if (!uncompleteTask(req.user.id, req.params.taskId)) {
    return res.status(404).json({ detail: 'Task not found or not completed' });
  }
  res.json({ status: 'pending' });
});

app.post('/api/tasks/:taskId/pause', requireUser, (req, res) => {
  const out = pauseTask(req.user.id, req.params.taskId);
  switch (out.result) {
    case 'ok':
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

app.post('/api/tasks/:taskId/steps', requireUser, (req, res) => {
  const { text } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ detail: 'text is required' });
  if (trimmed.length > 500) return res.status(400).json({ detail: 'text must be 500 characters or fewer' });
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  addChecklistItem(req.params.taskId, trimmed);
  res.json({ status: 'added' });
});

app.post('/api/tasks/:taskId/steps/generate', requireUser, async (req, res) => {
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  try {
    const existing = getChecklist(req.params.taskId);
    const newSteps = await generateStepsForTask(task, existing);
    for (const step of newSteps) {
      addChecklistItem(req.params.taskId, step);
    }
    res.json({ status: 'generated', added: newSteps.length });
  } catch (err) {
    console.error('[steps/generate]', err);
    res.status(502).json({ detail: err.message || 'AI step generation failed' });
  }
});

app.post('/api/tasks/:taskId/suggest', requireUser, async (req, res) => {
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  try {
    const suggestion = await suggestCalendarForTask(task, new Date());
    setAiSuggestion(req.user.id, task.id, suggestion);
    res.json(suggestion);
  } catch (err) {
    console.error('[tasks/suggest]', err);
    res.status(502).json({ detail: err.message || 'AI suggestion failed' });
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

app.post('/api/tasks/:taskId/step-delete', requireUser, (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number') {
    return res.status(400).json({ detail: 'index (number) is required' });
  }
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  // If no checklist items exist yet, lazily migrate plan steps into checklist_items first
  if (!getChecklist(req.params.taskId).length) {
    const plan = getPlan(req.user.id, req.params.taskId);
    if (Array.isArray(plan?.steps) && plan.steps.length) {
      replaceChecklist(req.params.taskId, plan.steps);
    }
  }
  if (!deleteChecklistItem(req.params.taskId, index)) {
    return res.status(404).json({ detail: 'Step not found' });
  }
  res.json({ status: 'deleted' });
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
  res.json({ ok: true });
});

app.delete('/api/tasks/:taskId/dependencies/:dep', requireUser, (req, res) => {
  const changed = removeTaskDependency(req.user.id, req.params.taskId, req.params.dep);
  if (!changed) return res.status(404).json({ detail: 'Dependency not found' });
  res.json({ ok: true });
});

app.get('/api/tasks/:taskId/timeline', requireUser, (req, res) => {
  const tl = getTimeline(req.user.id, req.params.taskId, 100);
  if (!tl) return res.status(404).json({ detail: 'Task not found' });
  res.json({ events: tl });
});

app.delete('/api/tasks/:taskId', requireUser, (req, res) => {
  const deleted = deleteTask(req.user.id, req.params.taskId);
  if (!deleted) return res.status(404).json({ detail: 'Task not found' });
  res.json({ ok: true });
});

app.post('/api/tasks/:taskId/deadline', requireUser, (req, res) => {
  const { deadline_iso } = req.body || {};
  const task = getTask(req.user.id, req.params.taskId);
  if (!task) return res.status(404).json({ detail: 'Task not found' });
  const iso = deadline_iso ? String(deadline_iso) : null;
  updateTaskField(req.user.id, req.params.taskId, 'deadline_iso', iso);
  if (iso) {
    const d = new Date(iso);
    const human = d.toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' });
    updateTaskField(req.user.id, req.params.taskId, 'deadline', human);
  } else {
    updateTaskField(req.user.id, req.params.taskId, 'deadline', null);
  }
  res.json({ ok: true });
});

app.post('/api/tasks/manual', requireUser, (req, res) => {
  const { task, priority = 'medium', quadrant, deadline, deadline_iso, estimated_duration_minutes, category = 'Other' } = req.body || {};
  if (!task || !String(task).trim()) {
    return res.status(400).json({ detail: 'task is required' });
  }
  const allowed = ['high', 'medium', 'low'];
  const p = allowed.includes(priority) ? priority : 'medium';
  const allowedQ = [null, 'do', 'plan', 'quick', 'later'];
  const q = allowedQ.includes(quadrant ?? null) ? (quadrant || null) : null;
  const dur = estimated_duration_minutes != null ? Math.max(5, Math.min(1440, Number(estimated_duration_minutes))) : null;

  const id = `m${Date.now()}`;
  const { idMap } = mergeNewTasks(req.user.id, [{
    id,
    task: String(task).trim(),
    deadline: deadline ?? null,
    deadline_iso: deadline_iso ?? null,
    assigned_by: null,
    priority: p,
    confidence: 1,
    category: String(category).trim() || 'Other',
    estimated_duration_minutes: dur,
    missing_fields: [],
    status: 'pending',
  }]);

  const realId = idMap[id] || id;
  if (q) setUserEisenhower(req.user.id, realId, q);

  res.json({ ok: true, id: realId });
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
  let prefParsedIso = null;
  if (field === 'deadline') {
    const parsed = await parseClarificationDeadline(String(value), new Date());
    if (parsed.error) {
      return res.status(400).json({ detail: parsed.error, code: 'bad_date' });
    }
    prefParsedIso = parsed.iso;
  }
  if (!respondToClarification(req.user.id, task_id, field, value, prefParsedIso)) {
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

app.get('/api/preferences', requireUser, (req, res) => {
  res.json(getPreferences(req.user.id));
});

app.put('/api/preferences', requireUser, (req, res) => {
  const updated = upsertPreferences(req.user.id, req.body || {});
  res.json(updated);
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
    return res.status(409).json({ detail: 'Google Calendar not linked', code: 'not_linked' });
  }

  const fresh = getTask(req.user.id, task.id);
  const plan = getPlan(req.user.id, task.id);
  try {
    const result = await upsertCalendarEvent(req.user.id, fresh, plan, new Date());

    if (result?.synced && result.event_id) {
      setCalendarSyncEnabled(req.user.id, task.id, 1);
      addTaskEvent(req.user.id, task.id, 'calendar_sync_toggled', { enabled: true });
      return res.json({ ok: true, synced: true, event_id: result.event_id });
    }

    if (result?.skipped) {
      return res.json({
        ok: false,
        synced: false,
        skipped: true,
        reason: result.reason || 'unknown',
        error: result.error || null,
      });
    }

    // synced === false + error
    return res.status(502).json({
      ok: false,
      synced: false,
      error: result?.error || 'Calendar sync failed',
    });
  } catch (err) {
    console.error('[/api/tasks/:id/calendar-sync] upsert error:', err.message);
    return res.status(502).json({ ok: false, synced: false, error: err.message || 'Calendar sync failed' });
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