import OpenAI from 'openai';

let _client = null;

const PROVIDERS = {
  zai: {
    apiKeyEnv: 'Z_AI_API_KEY',
    defaultBaseURL: 'https://api.z.ai/api/paas/v4/',
    baseURLEnv: 'Z_AI_BASE_URL',
    modelEnv: 'Z_AI_MODEL',
    defaultModel: 'glm-4.6',
  },
  gemini: {
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    baseURLEnv: 'GEMINI_BASE_URL',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
  }
};

function activeProviderName() {
  const p = (process.env.AI_PROVIDER || 'zai').toLowerCase();
  return PROVIDERS[p] ? p : 'zai';
}

export function getProviderName() {
  return activeProviderName();
}

export function getClient() {
  if (_client) return _client;
  const name = activeProviderName();
  const cfg = PROVIDERS[name];
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    throw new Error(`${cfg.apiKeyEnv} is not set. Copy .env.example to .env and add your ${name} key.`);
  }
  _client = new OpenAI({
    apiKey: key,
    baseURL: process.env[cfg.baseURLEnv] || cfg.defaultBaseURL,
  });
  return _client;
}

export const MODEL = (() => {
  const cfg = PROVIDERS[activeProviderName()];
  return process.env[cfg.modelEnv] || cfg.defaultModel;
})();

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
