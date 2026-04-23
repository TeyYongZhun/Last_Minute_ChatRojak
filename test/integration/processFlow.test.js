import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/modules/task1Parser.js', () => ({
  parseMessages: vi.fn(),
}));
vi.mock('../../src/modules/categorizer.js', () => ({
  categorizeTasks: vi.fn(async (tasks) => ({
    categories: Object.fromEntries(tasks.map((t) => [t.id, 'Academic'])),
    degraded: false,
  })),
  BUCKETS: ['Academic', 'Co-curricular', 'Others'],
}));
vi.mock('../../src/modules/validator.js', () => ({
  validateRun: vi.fn(async () => ({ issues: [], verdict: 'ok', source: 'test' })),
  MAX_RETRIES_PER_VERDICT: 2,
}));
vi.mock('../../src/modules/task2Planner.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    planTasks: vi.fn(async (tasks) => ({
      plans: tasks.map((t, i) => ({
        task_id: t.id,
        priority_score: 80 - i * 10,
        ai_priority_score: 80 - i * 10,
        user_adjusted_score: 80 - i * 10,
        decision: 'do_now',
        steps: ['Step 1', 'Step 2'],
        conflicts: [],
        missing_info_questions: [],
        status: 'pending',
      })),
      conflicts: [],
      dependencies: [],
    })),
  };
});

import { parseMessages } from '../../src/modules/task1Parser.js';
import { createApp } from '../../src/server.js';

async function signedInAgent(app, email) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/signup')
    .send({ email, password: 'password123' })
    .set('content-type', 'application/json');
  return agent;
}

describe('POST /api/process → /api/dashboard', () => {
  beforeEach(() => {
    parseMessages.mockReset();
  });

  it('creates tasks and surfaces them on dashboard with tags', async () => {
    parseMessages.mockResolvedValue([
      {
        id: 't1',
        task: 'Submit CS2103 assignment',
        deadline: 'Friday 11:59pm',
        deadline_iso: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        assigned_by: 'Professor',
        priority: 'high',
        confidence: 0.95,
        missing_fields: [],
        category: 'Academic',
        tags: ['urgent', 'solo'],
        status: 'pending',
      },
    ]);

    const app = createApp();
    const agent = await signedInAgent(app, 'proc@x.co');

    const res = await agent
      .post('/api/process')
      .send({ text: 'CS2103 assignment due Friday' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.tasks_extracted).toBe(1);
    expect(res.body.plans_created).toBe(1);

    const dash = await agent.get('/api/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.total_tasks).toBe(1);
    const item = dash.body.do_now[0];
    expect(item).toBeDefined();
    expect(item.task).toContain('CS2103');
    expect(item.tags).toEqual(expect.arrayContaining(['urgent', 'solo']));
  });

  it('returns 400 with no text', async () => {
    const app = createApp();
    const agent = await signedInAgent(app, 'proc2@x.co');
    const res = await agent
      .post('/api/process')
      .send({ text: '   ' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(400);
  });

  it('returns "No actionable tasks found" when parser yields empty', async () => {
    parseMessages.mockResolvedValue([]);
    const app = createApp();
    const agent = await signedInAgent(app, 'proc3@x.co');
    const res = await agent
      .post('/api/process')
      .send({ text: 'just idle chat' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.tasks_extracted).toBe(0);
  });
});
