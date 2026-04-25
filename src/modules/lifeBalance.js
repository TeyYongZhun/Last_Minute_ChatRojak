import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const VALID_STATUS = new Set(['balanced', 'slightly_busy', 'overloaded']);

const SYSTEM_PROMPT = `You are an intelligent workload and life-balance advisor.

Your job is to analyze a list of tasks and determine whether the user's workload is balanced or overloaded.

You must provide:
1. A clear workload status
2. A short, human-friendly explanation
3. A practical suggestion to improve balance

IMPORTANT:
- Do NOT mention technical analysis or scoring
- Do NOT talk about urgency, importance, or effort explicitly
- Keep everything simple, clear, and user-focused

INPUT: a list of tasks with { task, deadline_iso }.

Analyze:
- Task concentration: many tasks due on the same day or within 1-2 days?
- Task density: multiple deadlines very close together?
- Missing spacing: tasks poorly distributed instead of spread out?

Classify status into ONE of:
- "balanced" — tasks are reasonably spread out
- "slightly_busy" — some clustering, but still manageable
- "overloaded" — many tasks concentrated in a short time

Generate a short message and ONE practical suggestion. Examples:
- balanced → "Your workload looks well distributed" / "Keep up the good pacing"
- slightly_busy → "You have several tasks close together, but still manageable" / "Try spreading tasks across different days"
- overloaded → "You have multiple tasks due in a short period" / "Try starting earlier or spreading tasks across days to avoid last minute pressure"

Output ONLY JSON (no markdown, no commentary):
{"status":"balanced|slightly_busy|overloaded","message":"short explanation","suggestion":"practical advice"}`;

const FALLBACK = {
  balanced: { status: 'balanced', message: 'Your workload looks well distributed.', suggestion: 'Keep up the steady pace.' },
  empty:    { status: 'balanced', message: 'No active tasks right now.', suggestion: 'Add a task or import a chat to get started.' },
};

export async function analyzeWorkload(tasks, now = new Date()) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return FALLBACK.empty;

  const payload = list.map((t) => ({
    task: t.task || '',
    deadline_iso: t.deadline_iso || null,
  }));

  const userBody = `Now: ${now.toISOString()}\nTasks:\n${JSON.stringify(payload)}`;

  const client = getClient();
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userBody },
      ],
    })
  );

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);

  const status = VALID_STATUS.has(data?.status) ? data.status : 'balanced';
  const message = (typeof data?.message === 'string' && data.message.trim()) ? data.message.trim() : FALLBACK.balanced.message;
  const suggestion = (typeof data?.suggestion === 'string' && data.suggestion.trim()) ? data.suggestion.trim() : FALLBACK.balanced.suggestion;

  return { status, message, suggestion };
}
