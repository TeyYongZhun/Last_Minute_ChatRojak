import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const BUCKETS = ['Academic', 'Co-curricular', 'Others'];
const BUCKET_SET = new Set(BUCKETS);

const SYSTEM_PROMPT = `You are a strict classifier. For each task, assign exactly ONE bucket:

- Academic: coursework, assignments, lectures, tutorials, labs, exams, readings, research papers, study groups focused on academic material.
- Co-curricular: CCAs, clubs, sports, volunteering, student-organised events, performances, competitions, society meetings, camps.
- Others: admin, personal, finance, hostel, errands, social plans, anything that does not fit the other two buckets.

Rules:
- Output ONLY valid JSON, no markdown, no commentary.
- Output shape: {"categories": {"<task_id>": "Academic" | "Co-curricular" | "Others"}}
- Every task id in the input MUST appear in the output.
- Never invent ids. Never output a bucket outside the three above.`;

function fallbackBucket(task) {
  const text = `${task.task || ''} ${task.tags?.join(' ') || ''} ${task.assigned_by || ''}`.toLowerCase();
  if (/(cca|club|sport|volunteer|society|camp|performance|competition|concert|event)/.test(text)) return 'Co-curricular';
  if (/(assignment|homework|exam|midterm|final|quiz|lecture|tutorial|lab|course|module|project|essay|report|thesis|professor|lecturer|prof|tutor|study)/.test(text)) return 'Academic';
  return 'Others';
}

export async function categorizeTasks(tasks) {
  if (!tasks?.length) return { categories: {}, degraded: false };

  const payload = tasks.map((t) => ({
    id: t.id,
    task: t.task,
    tags: t.tags || [],
    assigned_by: t.assigned_by || null,
  }));

  const client = getClient();
  try {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Tasks:\n${JSON.stringify(payload)}` },
        ],
      })
    );
    const content = response.choices?.[0]?.message?.content || '';
    const data = extractJson(content);
    const raw = data.categories && typeof data.categories === 'object' ? data.categories : {};

    const categories = {};
    for (const t of tasks) {
      const bucket = raw[t.id];
      categories[t.id] = BUCKET_SET.has(bucket) ? bucket : fallbackBucket(t);
    }
    return { categories, degraded: false };
  } catch (err) {
    const categories = {};
    for (const t of tasks) categories[t.id] = fallbackBucket(t);
    return { categories, degraded: true, error: err.message };
  }
}

export { BUCKETS };
