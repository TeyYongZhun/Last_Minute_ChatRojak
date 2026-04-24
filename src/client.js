import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

let _client = null;

const PROVIDERS = {
  ilmuglm: {
    kind: 'openai',
    apiKeyEnv: 'ILMU_API_KEY',
    defaultBaseURL: 'https://api.ilmu.ai/v1',
    baseURLEnv: 'ILMU_BASE_URL',
    modelEnv: 'ILMU_MODEL',
    defaultModel: 'ilmu-glm-5.1',
  },
};

function activeProviderName() {
  const p = (process.env.AI_PROVIDER || 'ilmuglm').toLowerCase();
  return PROVIDERS[p] ? p : 'ilmuglm';
}

export function getProviderName() {
  return activeProviderName();
}

export function getProviderConfig() {
  return PROVIDERS[activeProviderName()];
}

export function getProviderKeyEnv() {
  return getProviderConfig().apiKeyEnv;
}

// Translates OpenAI chat/completions calls to Anthropic Messages calls and
// shapes the response back into the OpenAI format the call-sites already read.
// Only the subset actually used by this app is supported: system+user messages,
// temperature, and a text response on `choices[0].message.content`.
function createAnthropicShim({ apiKey, baseURL }) {
  const sdk = new Anthropic({ apiKey, baseURL });
  const DEFAULT_MAX_TOKENS = 8192;

  async function create({ model, messages = [], temperature, max_tokens }) {
    let system;
    const anthMessages = [];
    for (const m of messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.role === 'system') {
        system = system ? `${system}\n\n${content}` : content;
      } else {
        anthMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
      }
    }
    const req = {
      model,
      max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: anthMessages,
    };
    if (system) req.system = system;
    if (temperature != null) req.temperature = temperature;

    const res = await sdk.messages.create(req);
    const text = (res.content || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return {
      id: res.id,
      model: res.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: res.stop_reason === 'end_turn' ? 'stop' : res.stop_reason || 'stop',
        },
      ],
      usage: res.usage
        ? {
            prompt_tokens: res.usage.input_tokens,
            completion_tokens: res.usage.output_tokens,
            total_tokens: (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0),
          }
        : undefined,
    };
  }

  return { chat: { completions: { create } } };
}

export function getClient() {
  if (_client) return _client;
  const name = activeProviderName();
  const cfg = getProviderConfig();
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    throw new Error(`${cfg.apiKeyEnv} is not set. Copy .env.example to .env and add your ${name} key.`);
  }
  const baseURL = process.env[cfg.baseURLEnv] || cfg.defaultBaseURL;
  if (cfg.kind === 'anthropic') {
    _client = createAnthropicShim({ apiKey: key, baseURL });
  } else {
    const timeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 120_000;
    _client = new OpenAI({ apiKey: key, baseURL, timeout: timeoutMs });
  }
  return _client;
}

export const MODEL = (() => {
  const cfg = getProviderConfig();
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

// 504 included: slow model backends (e.g. ILMU GLM) often 504 on cold start, retry usually succeeds.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err) {
  if (!err) return false;
  if (err.status && RETRY_STATUS.has(err.status)) return true;
  const code = err.code || err.cause?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
  const name = err.name || err.cause?.name;
  if (name === 'APIConnectionTimeoutError' || name === 'APIConnectionError') return true;
  if (typeof err.message === 'string' && /timed out|timeout/i.test(err.message)) return true;
  return false;
}

export async function withRetry(fn, { retries = 3, baseMs = 600, maxWaitMs = 8000, onRetry } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) {
        if (err.status === 429) {
          err.message = 'API rate limit reached. Falling back to local heuristics.';
        }
        throw err;
      }
      let waitMs;
      if (err.status === 429) {
        // Rate limits don't clear in seconds on free tiers — don't stall the pipeline.
        // Honour Retry-After only if it's short; otherwise fail fast so degraded fallback runs.
        const retryAfterSec = Number(err.headers?.['retry-after'] ?? err.headers?.get?.('retry-after') ?? 0);
        if (retryAfterSec > 0 && retryAfterSec * 1000 <= maxWaitMs) {
          waitMs = retryAfterSec * 1000 + 200;
        } else {
          waitMs = 1500;
        }
      } else {
        const jitter = Math.random() * 0.3 + 0.85;
        waitMs = Math.min(maxWaitMs, Math.round(baseMs * 2 ** attempt * jitter));
      }
      const waitSec = Math.round(waitMs / 1000);
      console.warn(`[withRetry] attempt ${attempt + 1} failed (${err.status || err.code || err.message}), retrying in ${waitSec}s`);
      onRetry?.(`API error (${err.status || err.code || err.message}), retrying in ${waitSec}s…`);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt += 1;
    }
  }
}
