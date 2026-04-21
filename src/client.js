import OpenAI from 'openai';

let _client = null;

export function getClient() {
  if (_client) return _client;
  if (!process.env.Z_AI_API_KEY) {
    throw new Error('Z_AI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  _client = new OpenAI({
    apiKey: process.env.Z_AI_API_KEY,
    baseURL: process.env.Z_AI_BASE_URL || 'https://api.z.ai/api/paas/v4/',
  });
  return _client;
}

export const MODEL = process.env.Z_AI_MODEL || 'glm-4.6';

export function extractJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  let m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err) {
  if (!err) return false;
  if (err.status && RETRY_STATUS.has(err.status)) return true;
  const code = err.code || err.cause?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
  return false;
}

export async function withRetry(fn, { retries = 3, baseMs = 400 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const jitter = Math.random() * 0.3 + 0.85;
      const waitMs = Math.round(baseMs * 2 ** attempt * jitter);
      console.warn(`[withRetry] attempt ${attempt + 1} failed (${err.status || err.code || err.message}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
    }
  }
}
