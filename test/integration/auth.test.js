import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';

describe('auth flow', () => {
  it('signup → /me → logout → /me (unauthed)', async () => {
    const app = createApp();
    const agent = request.agent(app);

    const signup = await agent
      .post('/api/auth/signup')
      .send({ email: 'alice@x.co', password: 'passw0rd!' })
      .set('content-type', 'application/json');
    expect(signup.status).toBe(200);
    expect(signup.body.email).toBe('alice@x.co');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('alice@x.co');

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    const meAfter = await agent.get('/api/auth/me');
    expect(meAfter.status).toBe(401);
  });

  it('login with correct password, reject wrong password', async () => {
    const app = createApp();
    const signupAgent = request.agent(app);
    await signupAgent
      .post('/api/auth/signup')
      .send({ email: 'bob@x.co', password: 'correctpw1' })
      .set('content-type', 'application/json');
    await signupAgent.post('/api/auth/logout');

    const loginOk = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@x.co', password: 'correctpw1' })
      .set('content-type', 'application/json');
    expect(loginOk.status).toBe(200);

    const loginBad = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@x.co', password: 'wrongwrong' })
      .set('content-type', 'application/json');
    expect(loginBad.status).toBe(401);
  });

  it('rejects signup with short password', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'c@x.co', password: 'short' })
      .set('content-type', 'application/json');
    expect(res.status).toBe(400);
  });

  it('rejects duplicate email', async () => {
    const app = createApp();
    await request(app)
      .post('/api/auth/signup')
      .send({ email: 'dup@x.co', password: 'password1' })
      .set('content-type', 'application/json');
    const dup = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'dup@x.co', password: 'password1' })
      .set('content-type', 'application/json');
    expect(dup.status).toBe(409);
  });

  it('unauthenticated /api/dashboard returns 401', async () => {
    const app = createApp();
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
  });
});
