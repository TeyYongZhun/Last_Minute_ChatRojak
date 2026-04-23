import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import { resetAllLimiters } from '../../src/auth/rateLimit.js';

beforeEach(() => {
  resetAllLimiters();
});

describe('reset password (unauthenticated, email + new_password)', () => {
  it('happy path: reset → login with new password; old password fails', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'reset1@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');
    await agent.post('/api/auth/logout');

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset1@x.co', new_password: 'brandnewpw' })
      .set('content-type', 'application/json');
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    const loginNew = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset1@x.co', password: 'brandnewpw' })
      .set('content-type', 'application/json');
    expect(loginNew.status).toBe(200);

    const loginOld = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset1@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');
    expect(loginOld.status).toBe(401);
  });

  it('unknown email returns 404', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'nobody@nowhere.co', new_password: 'whateverpw' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(404);
  });

  it('rejects password shorter than 8 characters', async () => {
    const app = createApp();
    await request(app)
      .post('/api/auth/signup')
      .send({ email: 'short@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'short@x.co', new_password: '1234' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(400);
  });

  it('reset revokes all prior sessions', async () => {
    const app = createApp();
    const sessionA = request.agent(app);
    await sessionA
      .post('/api/auth/signup')
      .send({ email: 'revoke@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const meBefore = await sessionA.get('/api/auth/me');
    expect(meBefore.status).toBe(200);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'revoke@x.co', new_password: 'freshpasspw' })
      .set('content-type', 'application/json');

    const meAfter = await sessionA.get('/api/auth/me');
    expect(meAfter.status).toBe(401);
  });
});

describe('change password (authenticated)', () => {
  it('happy path: changes password, rotates session, other sessions revoked', async () => {
    const app = createApp();
    const agentA = request.agent(app);
    await agentA
      .post('/api/auth/signup')
      .send({ email: 'change@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const agentB = request.agent(app);
    await agentB
      .post('/api/auth/login')
      .send({ email: 'change@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const change = await agentA
      .post('/api/auth/change-password')
      .send({ current_password: 'originalpw', new_password: 'updatedpass' })
      .set('content-type', 'application/json');
    expect(change.status).toBe(200);

    const meA = await agentA.get('/api/auth/me');
    expect(meA.status).toBe(200);

    const meB = await agentB.get('/api/auth/me');
    expect(meB.status).toBe(401);

    const loginNew = await request(app)
      .post('/api/auth/login')
      .send({ email: 'change@x.co', password: 'updatedpass' })
      .set('content-type', 'application/json');
    expect(loginNew.status).toBe(200);

    const loginOld = await request(app)
      .post('/api/auth/login')
      .send({ email: 'change@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');
    expect(loginOld.status).toBe(401);
  });

  it('wrong current password → 403', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'wrongcur@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const res = await agent
      .post('/api/auth/change-password')
      .send({ current_password: 'wrongone', new_password: 'updatedpass' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(403);
  });

  it('same password rejected', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await agent
      .post('/api/auth/signup')
      .send({ email: 'samepass@x.co', password: 'originalpw' })
      .set('content-type', 'application/json');

    const res = await agent
      .post('/api/auth/change-password')
      .send({ current_password: 'originalpw', new_password: 'originalpw' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/differ/i);
  });

  it('unauthenticated → 401', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ current_password: 'anypw', new_password: 'newpasspw' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(401);
  });
});
