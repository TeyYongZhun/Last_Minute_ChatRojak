const buckets = new Map();

export function resetAllLimiters() {
  for (const store of buckets.values()) store.clear();
}

function nowMs() {
  return Date.now();
}

export function createLimiter({ max, windowMs, clock = nowMs } = {}) {
  if (!Number.isFinite(max) || max <= 0) throw new Error('max must be > 0');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be > 0');
  const id = Symbol('limiter');
  buckets.set(id, new Map());
  return {
    check(key) {
      if (!key) return { allowed: true, remaining: max };
      const now = clock();
      const store = buckets.get(id);
      const record = store.get(key);
      if (!record || now >= record.resetAt) {
        store.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
      }
      if (record.count >= max) {
        return { allowed: false, remaining: 0, resetAt: record.resetAt };
      }
      record.count += 1;
      return { allowed: true, remaining: max - record.count, resetAt: record.resetAt };
    },
    reset(key) {
      if (key == null) buckets.get(id).clear();
      else buckets.get(id).delete(key);
    },
  };
}

export function clientIp(req) {
  const xf = req.headers?.['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
