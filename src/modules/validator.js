import { getClient, MODEL, extractJson, withRetry } from '../client.js';

const MAX_RETRIES_PER_VERDICT = 2;
const VALID_BUCKETS = new Set(['Academic', 'Co-curricular', 'Others']);

const SYSTEM_PROMPT = `You are a QA reviewer for a task-extraction pipeline. You receive the merged output of two upstream steps (extract, plan). Identify concrete quality issues.

Check each task:
a) deadline_iso is present OR "deadline" is listed in missing_fields.
b) confidence >= 0.5 OR missing_fields is non-empty.
c) dependencies must not form a cycle, and must reference known task ids.

Output ONLY JSON, no commentary:
{
  "issues": [{"task_id": "<id or null>", "code": "<short_code>", "fix": "<short fix instruction>"}],
  "verdict": "ok" | "retry_extract" | "retry_plan" | "ask_user"
}

Guidelines:
- Prefer "ok" when issues are minor or already handled via missing_fields.
- Use "retry_plan" when dependencies are bad.
- Use "retry_extract" when deadline/confidence are clearly wrong across many tasks.
- Use "ask_user" when data is fundamentally incomplete and re-running will not help.`;

function localChecks(tasks, plans, dependencies) {
  const issues = [];
  const taskIds = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    const bucket = t.category_bucket ?? t.category ?? null;
    if (bucket && !VALID_BUCKETS.has(bucket)) {
      issues.push({ task_id: t.id, code: 'bad_bucket', fix: 'Use one of: Academic, Co-curricular, Others.' });
    }
    if (!t.deadline_iso && !(t.missing_fields || []).includes('deadline')) {
      issues.push({ task_id: t.id, code: 'missing_deadline', fix: 'Add "deadline" to missing_fields and open a clarification.' });
    }
    if ((t.confidence ?? 1) < 0.5 && !(t.missing_fields || []).length) {
      issues.push({ task_id: t.id, code: 'low_confidence', fix: 'Mark this task for clarification.' });
    }
  }
  for (const d of dependencies || []) {
    if (!taskIds.has(d.task_id) || !taskIds.has(d.depends_on)) {
      issues.push({ task_id: d.task_id, code: 'dangling_dependency', fix: 'Remove dependency referencing unknown task.' });
    }
  }
  return issues;
}

export async function validateRun({ tasks, plans, dependencies }) {
  const local = localChecks(tasks, plans, dependencies || []);

  if (!tasks.length) {
    return { issues: local, verdict: local.length ? 'ask_user' : 'ok', source: 'local' };
  }

  const client = getClient();
  const payload = {
    tasks: tasks.map((t) => ({
      id: t.id,
      task: t.task,
      deadline_iso: t.deadline_iso,
      missing_fields: t.missing_fields || [],
      confidence: t.confidence,
      category_bucket: t.category_bucket ?? t.category ?? null,
    })),
    plans: plans.map((p) => ({
      task_id: p.task_id,
      decision: p.decision,
      priority_score: p.priority_score,
    })),
    dependencies: (dependencies || []).map((d) => ({ task_id: d.task_id, depends_on: d.depends_on })),
  };

  try {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL,
        temperature: 0.0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      })
    );
    const content = response.choices?.[0]?.message?.content || '';
    const data = extractJson(content);
    const issues = Array.isArray(data.issues) ? data.issues : [];
    const verdict = ['ok', 'retry_extract', 'retry_plan', 'ask_user'].includes(data.verdict) ? data.verdict : 'ok';

    const mergedIssues = [...local];
    for (const issue of issues) {
      if (issue && typeof issue === 'object' && issue.code) {
        mergedIssues.push({
          task_id: issue.task_id ?? null,
          code: String(issue.code),
          fix: issue.fix ? String(issue.fix) : '',
        });
      }
    }
    return { issues: mergedIssues, verdict, source: 'ai' };
  } catch (err) {
    return {
      issues: local,
      verdict: local.length ? 'ask_user' : 'ok',
      source: 'local_fallback',
      error: err.message,
    };
  }
}

export { MAX_RETRIES_PER_VERDICT };
