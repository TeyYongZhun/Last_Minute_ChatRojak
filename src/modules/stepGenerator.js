import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const MAX_STEP_LENGTH = 200;
const MAX_NEW_STEPS = 5;

export async function generateStepsForTask(task, existingSteps = []) {
  const client = getClient();

  const existing = (existingSteps || [])
    .map((s) => (typeof s === 'string' ? s : s?.step || ''))
    .filter((s) => s && s.trim());

  const systemPrompt = `You are a task planner. Given a task (and optionally the action steps already drafted for it), output NEW concrete actionable steps that complement the existing list.

Rules:
- If the existing list is empty, produce 3-5 steps covering the full task.
- If steps already exist, produce 2-4 NEW steps that extend the list — do not repeat, paraphrase, or contradict existing steps.
- Each step must be imperative, specific, and <= 120 characters.
- Order steps in the sequence they should be executed.

Output ONLY valid JSON, no markdown, no commentary:
{ "steps": ["step 1", "step 2", ...] }`;

  const userBody = [
    `Task: ${task.task || ''}`,
    task.deadline ? `Deadline: ${task.deadline}` : '',
    task.assigned_by ? `Assigned by: ${task.assigned_by}` : '',
    existing.length
      ? `Existing steps:\n${existing.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : 'Existing steps: (none)',
  ].filter(Boolean).join('\n');

  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBody },
      ],
    })
  );

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  const raw = Array.isArray(data.steps) ? data.steps : [];

  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const cleaned = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    const trimmed = s.trim().slice(0, MAX_STEP_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
    if (cleaned.length >= MAX_NEW_STEPS) break;
  }
  return cleaned;
}
