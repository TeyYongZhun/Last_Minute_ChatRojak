import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { getDb } from '../../src/db/index.js';
import { resetAllLimiters } from '../../src/auth/rateLimit.js';

beforeEach(() => {
  resetAllLimiters();
});

function linkGoogle(userId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO google_oauth_tokens (user_id, access_token, refresh_token, expires_at, scope, calendar_id, linked_at)
     VALUES (?, ?, ?, ?, ?, 'primary', ?)`
  ).run(userId, 'fake-access-token', 'fake-refresh-token', Date.now() + 3600_000, 'calendar.events', Date.now());
}

function insertTask(userId, taskId, overrides = {}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
       id, user_id, task, deadline, deadline_iso, assigned_by,
       priority, confidence, category, missing_fields, status, created_at,
       ai_priority, user_priority, ai_priority_score, user_adjusted_score,
       category_bucket, updated_at, completed_at, complexity,
       ai_eisenhower, user_eisenhower, ai_duration_minutes, user_duration_minutes,
       calendar_sync_enabled
     ) VALUES (?, ?, ?, NULL, ?, NULL, 'medium', 0.9, 'Academic', '[]', 'pending', ?, 'medium', NULL, NULL, NULL, 'Academic', ?, NULL, NULL, NULL, NULL, ?, ?, 0)`
  ).run(
    taskId,
    userId,
    overrides.task ?? 'Submit lab report',
    overrides.deadline_iso ?? '2026-05-01T10:00:00+08:00',
    now,
    now,
    overrides.ai_duration_minutes ?? null,
    overrides.user_duration_minutes ?? null
  );
}

function setupFetchSpy() {
  const calls = [];
  const spy = vi.fn(async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    if (opts?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify({ id: 'ev-' + calls.length, etag: 'etag-' + calls.length }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  global.fetch = spy;
  return { spy, calls };
}

async function signupAndLinkGoogle(app) {
  const agent = request.agent(app);
  const signup = await agent
    .post('/api/auth/signup')
    .send({ email: `cal${Date.now()}@x.co`, password: 'originalpw' })
    .set('content-type', 'application/json');
  linkGoogle(signup.body.id);
  return { agent, userId: signup.body.id };
}

describe('POST /api/tasks/:taskId/calendar-sync', () => {
  it('default off: no Google event is created when a task is inserted', async () => {
    const app = createApp();
    const { calls } = setupFetchSpy();
    const { userId, agent } = await signupAndLinkGoogle(app);
    insertTask(userId, 't1');

    await agent.post('/api/replan').send({}).set('content-type', 'application/json');
    expect(calls.length).toBe(0);
  });

  it('toggle on with deadline + duration: POSTs event with verbatim summary and exact start/end', async () => {
    const app = createApp();
    const { calls } = setupFetchSpy();
    const { userId, agent } = await signupAndLinkGoogle(app);
    insertTask(userId, 't1', { task: 'Submit lab report', user_duration_minutes: 75 });

    const res = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: true })
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeTruthy();
    expect(post.body.summary).toBe('Submit lab report');
    expect(post.body.start.dateTime).toBe('2026-05-01T10:00:00+08:00');
    const deltaMs = new Date(post.body.end.dateTime).getTime() - new Date(post.body.start.dateTime).getTime();
    expect(deltaMs).toBe(75 * 60 * 1000);
    expect(post.body.start.timeZone).toBeUndefined();
  });

  it('toggle on with ai_duration_minutes only: duration = ai estimate', async () => {
    const app = createApp();
    const { calls } = setupFetchSpy();
    const { userId, agent } = await signupAndLinkGoogle(app);
    insertTask(userId, 't1', { ai_duration_minutes: 45, user_duration_minutes: null });

    const res = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: true })
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);

    const post = calls.find((c) => c.method === 'POST');
    const deltaMs = new Date(post.body.end.dateTime).getTime() - new Date(post.body.start.dateTime).getTime();
    expect(deltaMs).toBe(45 * 60 * 1000);
  });

  it('toggle on without Google linked: 409', async () => {
    const app = createApp();
    setupFetchSpy();
    const agent = request.agent(app);
    const signup = await agent
      .post('/api/auth/signup')
      .send({ email: `nolink${Date.now()}@x.co`, password: 'originalpw' })
      .set('content-type', 'application/json');
    insertTask(signup.body.id, 't1');

    const res = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: true })
      .set('content-type', 'application/json');
    expect(res.status).toBe(409);

    const db = getDb();
    const row = db.prepare('SELECT calendar_sync_enabled FROM tasks WHERE id = ?').get('t1');
    expect(row.calendar_sync_enabled).toBe(0);
  });

  it('toggle off after on: DELETE is issued to Google', async () => {
    const app = createApp();
    const { calls } = setupFetchSpy();
    const { userId, agent } = await signupAndLinkGoogle(app);
    insertTask(userId, 't1');

    await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: true })
      .set('content-type', 'application/json');

    const off = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: false })
      .set('content-type', 'application/json');
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del).toBeTruthy();
  });

  it('404 on unknown task', async () => {
    const app = createApp();
    setupFetchSpy();
    const { agent } = await signupAndLinkGoogle(app);

    const res = await agent
      .post('/api/tasks/does-not-exist/calendar-sync')
      .send({ enabled: true })
      .set('content-type', 'application/json');
    expect(res.status).toBe(404);
  });

  it('400 when enabled is missing or non-boolean', async () => {
    const app = createApp();
    setupFetchSpy();
    const { agent } = await signupAndLinkGoogle(app);

    const r1 = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({})
      .set('content-type', 'application/json');
    expect(r1.status).toBe(400);

    const r2 = await agent
      .post('/api/tasks/t1/calendar-sync')
      .send({ enabled: 'yes' })
      .set('content-type', 'application/json');
    expect(r2.status).toBe(400);
  });
});
