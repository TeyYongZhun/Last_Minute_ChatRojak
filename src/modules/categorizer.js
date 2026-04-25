import { getClient, MODEL, extractJson, withRetry } from '../client.js';

export const BUCKETS = ['Academic', 'Co-curricular', 'Others'];
const BUCKET_SET = new Set(BUCKETS);

const SYSTEM_PROMPT = `You classify tasks into one of three buckets:
- Academic
- Co-curricular
- Others

Return ONLY JSON:
{
  "categories": {"<task_id>": "Academic|Co-curricular|Others"}
}`;

function heuristicBucket(task) {
  const text = `${task?.task || ''} ${(task?.tags || []).join(' ')}`.toLowerCase();
  if (/(assignment|quiz|exam|midterm|lecture|tutorial|lab|course|module|cs\d{3,4}|homework|study|revision|professor|school|university)/.test(text)) {
    return 'Academic';
  }
  if (/(cca|club|society|rehearsal|training|committee|event|volunteer|competition|team practice)/.test(text)) {
    return 'Co-curricular';
  }
  return 'Others';
}

function sanitizeCategories(tasks, categories, fallbackToHeuristic = true) {
  const out = {};
  for (const t of tasks) {
    const raw = categories?.[t.id];
    if (BUCKET_SET.has(raw)) {
      out[t.id] = raw;
    } else {
      out[t.id] = fallbackToHeuristic ? heuristicBucket(t) : 'Others';
    }
  }
  return out;
}

export async function categorizeTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { categories: {}, degraded: false, source: 'empty' };
  }

  const payload = tasks.map((t) => ({ id: t.id, task: t.task || '', tags: Array.isArray(t.tags) ? t.tags : [] }));

  try {
    const client = getClient();
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      })
    );
    const text = response.choices?.[0]?.message?.content || '';
    const data = extractJson(text);
    const categories = sanitizeCategories(tasks, data?.categories, true);
    return { categories, degraded: false, source: 'ai' };
  } catch {
    const categories = sanitizeCategories(tasks, null, true);
    return { categories, degraded: true, source: 'heuristic' };
  }
}
