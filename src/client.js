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

export const MODEL = process.env.Z_AI_MODEL || 'glm-4.5';

export function extractJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  let m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}
