import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const VALID_URGENCY = new Set(['do_now', 'plan', 'quick_win', 'later']);

const SYSTEM_PROMPT = `You are an intelligent task planner.

Your job is to analyze a task and:
1. Classify its urgency
2. Decide whether it should be suggested for Google Calendar
3. Provide a clear, human-friendly explanation

IMPORTANT:
- You are making a recommendation, NOT a final decision
- The user will decide whether to schedule the task
- Do NOT expose technical scoring or internal calculations

Urgency classes:
- "do_now": deadline within 24-48 hours, OR task text contains strong words (submit, urgent, ASAP, deadline)
- "plan": has a deadline but not immediate, AND task is important (assignment, project, meeting)
- "quick_win": small/simple task, low effort, can be completed quickly
- "later": low urgency, optional or non-critical

Calendar suggestion rules:
- If deadline_iso is null → suggest_calendar = false, reason = "Missing deadline"
- If urgency is "do_now" or "plan" → suggest_calendar = true
- If urgency is "quick_win" or "later" → suggest_calendar = false

Reason guidelines:
- Short, user-friendly explanation
- Never mention scores, calculations, or internal terms
- Good examples: "Due soon and important", "Upcoming deadline", "Small task, no scheduling needed", "Low priority, can be done later", "Missing deadline"

Output ONLY JSON (no markdown, no commentary):
{"urgency":"do_now|plan|quick_win|later","suggest_calendar":true|false,"reason":"short explanation"}`;

function defaultForDone() {
  return { urgency: 'later', suggest_calendar: false, reason: 'Not relevant or already completed' };
}

function defaultForMissingDeadline(urgency = 'later') {
  return { urgency, suggest_calendar: false, reason: 'Missing deadline' };
}

export async function suggestCalendarForTask(task, now = new Date()) {
  if (!task) throw new Error('Task is required');

  if (task.status === 'done') return defaultForDone();

  const payload = {
    task: task.task || '',
    deadline_iso: task.deadline_iso || null,
    assigned_by: task.assigned_by || null,
    is_for_user: true,
    status: task.status || 'pending',
  };

  const userBody = `Now: ${now.toISOString()}\nTask:\n${JSON.stringify(payload)}`;

  const client = getClient();
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userBody },
      ],
    })
  );

  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);

  const urgency = VALID_URGENCY.has(data?.urgency) ? data.urgency : 'later';
  const reason = (typeof data?.reason === 'string' && data.reason.trim()) ? data.reason.trim() : 'No suggestion available';

  // Enforce the deadline rule regardless of what the model said
  if (!task.deadline_iso) return defaultForMissingDeadline(urgency);

  const suggest_calendar = urgency === 'do_now' || urgency === 'plan';
  return { urgency, suggest_calendar, reason };
}
