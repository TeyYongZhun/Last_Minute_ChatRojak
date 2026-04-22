import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

async function signedInAgent(app, email) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/signup')
    .send({ email, password: 'password123' })
    .set('content-type', 'application/json');
  return agent;
}

describe('dashboard two-user isolation', () => {
  it('does not leak tasks between users', async () => {
    const app = createApp();
    const alice = await signedInAgent(app, 'alice@x.co');
    const bob = await signedInAgent(app, 'bob@x.co');

    await alice.post('/api/demo-seed').send({});
    const aliceDash = await alice.get('/api/dashboard');
    expect(aliceDash.status).toBe(200);
    expect(aliceDash.body.total_tasks).toBeGreaterThan(0);

    const bobDash = await bob.get('/api/dashboard');
    expect(bobDash.status).toBe(200);
    expect(bobDash.body.total_tasks).toBe(0);
  });

  it('returns 404 when one user tries to mutate another user\'s task', async () => {
    const app = createApp();
    const alice = await signedInAgent(app, 'a@x.co');
    const bob = await signedInAgent(app, 'b@x.co');

    await alice.post('/api/demo-seed').send({});

    const bobComplete = await bob.post('/api/tasks/t1/complete').send({});
    expect(bobComplete.status).toBe(404);

    const bobStart = await bob.post('/api/tasks/t1/start').send({});
    expect(bobStart.status).toBe(404);
  });

  it('filters tags correctly per user', async () => {
    const app = createApp();
    const alice = await signedInAgent(app, 'alice2@x.co');
    await alice.post('/api/demo-seed').send({});

    const urgent = await alice.get('/api/dashboard?tags=urgent');
    const urgentIds = [
      ...urgent.body.do_now,
      ...urgent.body.schedule,
      ...urgent.body.defer,
      ...urgent.body.need_info,
      ...urgent.body.in_progress,
    ].map((t) => t.task_id);
    expect(urgentIds).toContain('t1');
    expect(urgentIds).not.toContain('t2');
  });
});
