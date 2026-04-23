import { describe, it, expect } from 'vitest';
import { createLimiter } from '../../src/auth/rateLimit.js';

describe('rate limiter', () => {
  it('allows up to max then blocks', () => {
    let now = 1000;
    const clock = () => now;
    const limiter = createLimiter({ max: 3, windowMs: 1000, clock });
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('refills after window expires', () => {
    let now = 1000;
    const clock = () => now;
    const limiter = createLimiter({ max: 2, windowMs: 1000, clock });
    limiter.check('k');
    limiter.check('k');
    expect(limiter.check('k').allowed).toBe(false);
    now += 1001;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('different keys are independent', () => {
    const limiter = createLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(false);
  });

  it('no-op on empty key', () => {
    const limiter = createLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('').allowed).toBe(true);
    expect(limiter.check('').allowed).toBe(true);
  });

  it('reset clears a key', () => {
    const limiter = createLimiter({ max: 1, windowMs: 1000 });
    limiter.check('k');
    expect(limiter.check('k').allowed).toBe(false);
    limiter.reset('k');
    expect(limiter.check('k').allowed).toBe(true);
  });
});
