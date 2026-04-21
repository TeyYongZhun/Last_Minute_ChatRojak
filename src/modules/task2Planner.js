import { getClient, MODEL, extractJson, withRetry } from '../client.js';
import { buildPlanRequest } from './adapter.js';

const PLANNER_SYSTEM_PROMPT = `You are an AI workflow planner. You receive a list of tasks extracted from chat messages and must reason about how to prioritise, decompose, and schedule them.

For EACH task, output a plan object with these fields:
- task_id: string (must match the input id)
- priority_score: integer 0-100, your holistic judgement weighing urgency (deadline distance), importance (who assigned it, priority tag), effort (complexity), and dependencies
- justification: one sentence explaining the score
- decision: one of "do_now" (score >= 80 and ready), "schedule" (50-79 and ready), "defer" (< 50 and ready), or "ask_user" (missing info blocks planning)
- steps: array of 3-5 objects, each { "index": int, "text": "concrete actionable step", "depends_on": [int indices] } — earlier indices should generally come first
- conflicts: array of strings describing clashes with other tasks (deadline overlap within a few hours, same-time commitments). Empty array if none.
- missing_info_questions: array of specific questions for any missing_fields. Empty array if nothing is missing.
- status: "pending" if ready to act, "blocked_waiting_info" if decision is "ask_user", "in_progress" if continuing prior work

Also output a top-level conflicts array, each entry: { "ids": [task_id, task_id], "message": "human explanation, stating which should win and why" }.

Reasoning rules:
- Overdue deadlines (deadline_iso < now_iso) should always push priority_score >= 90.
- Tasks from lecturer/professor/manager/boss carry more importance than friend/classmate.
- Consider whether tasks can be done in parallel or must serialise (a 3pm meeting blocks other do_now work at 3pm).
- If two tasks overlap, pick a winner based on flexibility (meetings usually can't shift; assignments can start earlier).
- Use the previous_decisions map to stay consistent across replans unless new info justifies a change.

Output ONLY valid JSON, no markdown, no commentary:
{"plans": [...], "conflicts": [...]}`;

function clampScore(n) {
  if (typeof n !== 'number' || isNaN(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isOverdue(deadlineIso, now) {
  if (!deadlineIso) return false;
  const d = new Date(deadlineIso);
  if (isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime();
}

function normalizeSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps
    .map((s, i) => {
      if (typeof s === 'string') {
        return { index: i, text: s.trim(), depends_on: i === 0 ? [] : [i - 1] };
      }
      if (s && typeof s === 'object') {
        const text = typeof s.text === 'string' ? s.text.trim() : '';
        if (!text) return null;
        const index = typeof s.index === 'number' ? s.index : i;
        const depends_on = Array.isArray(s.depends_on)
          ? s.depends_on.filter((d) => typeof d === 'number' && d >= 0 && d < rawSteps.length)
          : [];
        return { index, text, depends_on };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizePlan(rawPlan, task, now) {
  let score = clampScore(rawPlan.priority_score);
  if (isOverdue(task.deadline_iso, now) && score < 90) score = 90;

  const missingQs = Array.isArray(rawPlan.missing_info_questions)
    ? rawPlan.missing_info_questions.filter((q) => typeof q === 'string' && q.trim().length)
    : [];

  let decision = rawPlan.decision;
  let status = rawPlan.status;

  const validDecisions = new Set(['do_now', 'schedule', 'defer', 'ask_user']);
  if (!validDecisions.has(decision)) {
    if (missingQs.length) decision = 'ask_user';
    else if (score >= 80) decision = 'do_now';
    else if (score >= 50) decision = 'schedule';
    else decision = 'defer';
  }

  if (decision === 'ask_user') status = 'blocked_waiting_info';
  else if (!['pending', 'in_progress', 'done'].includes(status)) status = 'pending';

  return {
    task_id: task.id,
    priority_score: score,
    justification: typeof rawPlan.justification === 'string' ? rawPlan.justification.trim() : '',
    decision,
    steps: normalizeSteps(rawPlan.steps),
    conflicts: Array.isArray(rawPlan.conflicts) ? rawPlan.conflicts.filter((c) => typeof c === 'string') : [],
    missing_info_questions: missingQs,
    status,
  };
}

function fallbackPlan(task, reason) {
  return {
    task_id: task.id,
    priority_score: 50,
    justification: reason,
    decision: 'ask_user',
    steps: [],
    conflicts: [],
    missing_info_questions: [`I couldn't plan '${task.task}' automatically — can you break it down or clarify?`],
    status: 'blocked_waiting_info',
  };
}

async function callReasoner(planRequest) {
  const client = getClient();
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(planRequest) },
      ],
    })
  );
  const content = response.choices?.[0]?.message?.content || '';
  return extractJson(content);
}

export async function planTasks(tasks, now, prevPlans = []) {
  if (!tasks.length) return { plans: [], conflicts: [] };

  const planRequest = buildPlanRequest(tasks, prevPlans, now);
  let aiResult;
  try {
    aiResult = await callReasoner(planRequest);
  } catch (e) {
    console.error('[task2Planner] AI reasoner failed:', e.message);
    return {
      plans: tasks.map((t) => fallbackPlan(t, 'AI planner unavailable — needs manual review')),
      conflicts: [],
      ai_error: e.message,
    };
  }

  const rawPlans = Array.isArray(aiResult.plans) ? aiResult.plans : [];
  const byId = new Map();
  for (const rp of rawPlans) {
    if (rp && typeof rp.task_id === 'string') byId.set(rp.task_id, rp);
  }

  const plans = tasks.map((task) => {
    const rp = byId.get(task.id);
    if (!rp) return fallbackPlan(task, 'AI planner omitted this task');
    return normalizePlan(rp, task, now);
  });

  const conflicts = Array.isArray(aiResult.conflicts)
    ? aiResult.conflicts
        .filter((c) => c && Array.isArray(c.ids) && typeof c.message === 'string')
        .map((c) => ({ ids: c.ids, message: c.message }))
    : [];

  plans.sort((a, b) => b.priority_score - a.priority_score);
  return { plans, conflicts };
}
