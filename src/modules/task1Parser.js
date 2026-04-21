import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const SYSTEM_PROMPT = `You are a task extraction AI. Given raw chat messages (e.g., from WhatsApp groups), identify and extract actionable tasks.

For each actionable task found, produce:
- id: unique string starting from t1, t2, ...
- task: clear, concise task description
- deadline: human-readable deadline (e.g., "Friday 11:59pm") or null
- deadline_iso: ISO 8601 datetime relative to the current time provided, or null if unknown. Assume +08:00 timezone.
- assigned_by: who assigned/requested it (e.g., "Lecturer", "Classmate", "CS Society") or null
- priority: "high", "medium", or "low" based on urgency and source
- confidence: 0.0-1.0 how confident you are this is a real actionable task
- missing_fields: array of important missing fields, e.g. ["deadline"] or ["assigned_by"]

Rules:
- Only extract ACTIONABLE tasks that require the reader to DO something
- Ignore casual replies, greetings, acknowledgements ("ok", "noted", "sure np")
- If confidence < 0.6 still include it but list missing_fields
- Generate IDs starting at t1 counting up

Output ONLY a single valid JSON object, no markdown, no commentary:
{"tasks": [ ... ]}`;

function normalize(t, index) {
  return {
    id: String(t.id || `t${index + 1}`),
    task: String(t.task || '').trim(),
    deadline: t.deadline ?? null,
    deadline_iso: t.deadline_iso ?? null,
    assigned_by: t.assigned_by ?? null,
    priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
    confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : 0.8,
    missing_fields: Array.isArray(t.missing_fields) ? t.missing_fields : [],
    status: 'pending',
  };
}

export async function parseMessages(rawText, now) {
  const client = getClient();
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current time: ${now.toISOString()}\n\nChat messages to analyze:\n\n${rawText}`,
        },
      ],
    })
  );

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
  return rawTasks
    .map((t, i) => normalize(t, i))
    .filter((t) => t.task.length > 0);
}
