import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const SYSTEM_PROMPT = `You are a task extraction AI. Given raw WhatsApp chat messages, identify and extract actionable tasks.

For each actionable task found, produce:
- id: unique string starting from t1, t2, ...
- task: clear, concise task description
- deadline: human-readable deadline (e.g., "Friday 11:59pm") or null
- deadline_iso: ISO 8601 datetime relative to the current time provided, or null if unknown. Assume +08:00 timezone.
- assigned_by: who assigned/requested it (e.g., "Lecturer", "Classmate", "CS Society") or null
- priority: "high", "medium", or "low" based on urgency and source
- estimated_duration_minutes: integer 5..1440, best guess of focused work time needed. Do not pad for breaks. Examples: a 30-second reply ≈ 5, a short reading ≈ 15, a problem set ≈ 90, a full essay draft ≈ 240.
- confidence: 0.0-1.0 how confident you are this is a real actionable task
- missing_fields: array of important missing fields, e.g. ["deadline"] or ["assigned_by"]
- category: short label (1-2 words) for the kind of task — pick a natural label from the chat itself, e.g. "Academic", "CCA", "Admin", "Errand". Reuse the same label across related tasks in the same chat.
- tags: array of 1-4 short lowercase kebab-case organizing labels. Pick from this suggested vocabulary when they fit, but you may add one more original tag if useful:
    "urgent"          — must be done within 24h or marked urgent by sender
    "blocking"        — other work/people depend on this task
    "group-work"      — requires coordinating with others
    "solo"            — can be done alone end-to-end
    "short"           — likely under 30 minutes of effort
    "long"            — likely over a few hours or multi-session
    "needs-research"  — requires reading/learning before acting
    "waiting-on-others" — cannot progress until someone else replies/acts
    "recurring"       — part of a repeating obligation
  Prefer reusing tags across related tasks. Only use lowercase letters, digits, and hyphens.

Rules:
- Only extract ACTIONABLE tasks that require the reader to DO something
- Ignore casual replies, greetings, acknowledgements ("ok", "noted", "sure np", "lol", "hahaha")
- TIMEFRAME FILTER: If a timeframe filter is specified in the user message, read the timestamps on each chat message carefully. Completely skip and ignore any messages outside the allowed date range — do not extract tasks from them.
- DEDUPLICATE: if the same task is mentioned multiple times, extract it ONCE using the most recent confirmed deadline
- QUESTIONS vs STATEMENTS: Messages ending with "?" are questions/suggestions, NOT confirmed facts. Only treat a time/deadline as confirmed if it is stated as a declaration (e.g. "meeting tmr 3pm"), not as a question (e.g. "meeting tmr 3pm?")
- When deadlines conflict, use the LATEST authoritative statement from the person who assigned the task
- "before Friday" means the deadline is end of Thursday (Thursday 11:59pm), NOT Friday
- "by Friday" means end of Friday (Friday 11:59pm)
- Relative days like "tmr", "tomorrow", "next Monday" must be resolved using the current time provided
- If confidence < 0.6 still include it but list missing_fields
- Generate IDs starting at t1 counting up

Output ONLY a single valid JSON object, no markdown, no commentary:
{"tasks": [ ... ]}`;

function normaliseTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!t || t.length > 30) return null;
  return t;
}

function normaliseTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = normaliseTag(item);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}

function normalize(t, index) {
  const priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
  const rawDur = t.estimated_duration_minutes;
  const estimated_duration_minutes = typeof rawDur === 'number' && isFinite(rawDur)
    ? Math.max(5, Math.min(1440, Math.round(rawDur)))
    : null;
  return {
    id: String(t.id || `t${index + 1}`),
    task: String(t.task || '').trim(),
    deadline: t.deadline ?? null,
    deadline_iso: t.deadline_iso ?? null,
    assigned_by: t.assigned_by ?? null,
    priority,
    ai_priority: priority,
    user_priority: null,
    confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : 0.8,
    missing_fields: Array.isArray(t.missing_fields) ? t.missing_fields : [],
    category: typeof t.category === 'string' && t.category.trim() ? t.category.trim() : 'Other',
    category_bucket: null,
    tags: normaliseTags(t.tags),
    complexity: null,
    estimated_duration_minutes,
    status: 'pending',
  };
}

function buildTimeframeInstruction(timeframe, now) {
  if (timeframe === 'last7') {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    return `Timeframe filter: Only extract tasks from messages dated on or after ${cutoff.toDateString()} (last 7 days). Completely ignore messages with timestamps before this date.`;
  }
  if (timeframe === 'thisMonth') {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), 1);
    return `Timeframe filter: Only extract tasks from messages dated on or after ${cutoff.toDateString()} (this calendar month). Completely ignore messages with timestamps before this date.`;
  }
  return '';
}

export async function parseMessages(rawText, now, timeframe = 'all', { onProgress } = {}) {
  const client = getClient();
  const timeframeNote = buildTimeframeInstruction(timeframe, now);
  const userContent = [
    `Current time: ${now.toISOString()}`,
    timeframeNote,
    '',
    'Chat messages to analyze:',
    '',
    rawText,
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await withRetry(
      () => client.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
      { onRetry: (msg) => onProgress?.({ kind: 'warn', text: msg }) }
    );
  } catch (err) {
    const wrapped = new Error(`Extract step failed: ${err.message}`);
    wrapped.cause = err;
    wrapped.step = 'extract';
    throw wrapped;
  }

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
  return rawTasks
    .map((t, i) => normalize(t, i))
    .filter((t) => t.task.length > 0);
}

export { normaliseTags };
