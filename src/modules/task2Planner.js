import { getClient, MODEL, extractJson, withRetry } from '../client.js';

export function scoreUrgency(deadlineIso, now) {
  if (!deadlineIso) return 20;
  const d = new Date(deadlineIso);
  if (isNaN(d.getTime())) return 20;
  const hours = (d.getTime() - now.getTime()) / 3_600_000;
  if (hours < 0) return 100;
  if (hours < 12) return 95;
  if (hours < 24) return 85;
  if (hours < 72) return 70;
  if (hours < 168) return 50;
  return 30;
}

export function scoreImportance(assignedBy, priority) {
  let score = 0;
  if (assignedBy) {
    const al = assignedBy.toLowerCase();
    if (['lecturer', 'professor', 'prof', 'teacher', 'manager', 'boss'].some((w) => al.includes(w))) {
      score += 30;
    } else if (['friend', 'classmate', 'colleague'].some((w) => al.includes(w))) {
      score += 15;
    } else {
      score += 20;
    }
  } else {
    score += 10;
  }
  if (priority === 'high') score += 25;
  else if (priority === 'medium') score += 15;
  else score += 5;
  return Math.min(score, 55);
}

export function scoreEffort(taskDesc) {
  const words = taskDesc.split(/\s+/).length;
  if (words > 15) return 5;
  if (words > 8) return 10;
  return 15;
}

export function applyAdaptiveWeights({ urgency, importance, effort }, weights = null) {
  const w = weights && weights.active ? weights : { urgency: 0, importance: 0, effort: 0 };
  const uW = 0.5 + w.urgency;
  const iW = 0.35 + w.importance;
  const eW = 0.15 + w.effort;
  const sum = uW + iW + eW || 1;
  const nu = uW / sum, ni = iW / sum, ne = eW / sum;
  return Math.round(urgency * nu + importance * ni + effort * ne);
}

export function detectConflicts(tasks) {
  const conflicts = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const t1 = tasks[i];
      const t2 = tasks[j];
      if (!t1.deadline_iso || !t2.deadline_iso) continue;
      const d1 = new Date(t1.deadline_iso);
      const d2 = new Date(t2.deadline_iso);
      if (isNaN(d1.getTime()) || isNaN(d2.getTime())) continue;
      const diffHours = Math.abs(d1.getTime() - d2.getTime()) / 3_600_000;
      if (diffHours < 3) {
        let winner, reason;
        if (d1.getTime() !== d2.getTime()) {
          winner = d1.getTime() < d2.getTime() ? t1 : t2;
          reason = 'earlier deadline';
        } else {
          const imp1 = scoreImportance(t1.assigned_by, t1.priority);
          const imp2 = scoreImportance(t2.assigned_by, t2.priority);
          winner = imp1 >= imp2 ? t1 : t2;
          reason = 'higher importance';
        }
        conflicts.push({
          kind: 'deadline_clash',
          ids: [t1.id, t2.id],
          message: `Deadline clash: '${t1.task}' and '${t2.task}' are due within ${Math.round(diffHours * 60)} minutes of each other. Recommend prioritizing '${winner.task}' first (${reason}).`,
        });
      }
    }
  }

  // Overload: more than 4 "do now" candidates sharing the same calendar day
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.deadline_iso) continue;
    const d = new Date(t.deadline_iso);
    if (isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }
  for (const [day, list] of byDay) {
    if (list.length > 4) {
      conflicts.push({
        kind: 'overload',
        ids: list.map((t) => t.id),
        message: `Workload warning: ${list.length} tasks due on ${day}. Consider deferring the lower-priority ones.`,
      });
    }
  }

  return conflicts;
}

async function generatePlanAI(tasks, context = {}) {
  if (!tasks.length) return { steps_by_id: {}, complexity_by_id: {}, dependencies: [] };
  const client = getClient();

  const taskList = tasks.map((t) => ({
    id: t.id,
    task: t.task,
    deadline: t.deadline,
    deadline_iso: t.deadline_iso,
    category_bucket: t.category_bucket || 'Others',
    priority: t.priority,
    tags: t.tags || [],
  }));

  const systemPrompt = `You are a task planner. For each task given, produce:
- steps: 3-5 concrete actionable steps (array of strings)
- complexity: one of "simple" | "moderate" | "complex"
Also propose inter-task dependencies ONLY when one task clearly gates another (e.g. "submit report" depends on "finish analysis"). Never create cycles. Use exact task ids.

Output ONLY valid JSON, no markdown, no commentary:
{
  "steps_by_id": {"<id>": ["step 1", ...]},
  "complexity_by_id": {"<id>": "simple" | "moderate" | "complex"},
  "dependencies": [{"task_id": "<id>", "depends_on": "<id>", "reason": "<short>"}]
}`;

  const userBody = [
    context.weightsSummary ? `User context: ${context.weightsSummary}` : '',
    `Tasks:`,
    JSON.stringify(taskList),
  ].filter(Boolean).join('\n\n');

  try {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userBody },
        ],
      })
    );
    const content = response.choices?.[0]?.message?.content || '';
    const data = extractJson(content);
    return {
      steps_by_id: data.steps_by_id && typeof data.steps_by_id === 'object' ? data.steps_by_id : {},
      complexity_by_id: data.complexity_by_id && typeof data.complexity_by_id === 'object' ? data.complexity_by_id : {},
      dependencies: Array.isArray(data.dependencies) ? data.dependencies : [],
    };
  } catch (err) {
    return { steps_by_id: {}, complexity_by_id: {}, dependencies: [], degraded: true, error: err.message };
  }
}

export function scorePlan(tasks, now, { weights = null, blockedIds = null } = {}) {
  const conflicts = detectConflicts(tasks);
  const conflictMsgMap = {};
  for (const c of conflicts) {
    for (const tid of c.ids) {
      (conflictMsgMap[tid] ||= []).push(c.message);
    }
  }

  const blocked = blockedIds instanceof Set ? blockedIds : new Set(blockedIds || []);

  const plans = tasks.map((task) => {
    const urgency = scoreUrgency(task.deadline_iso, now);
    const importance = scoreImportance(task.assigned_by, task.priority);
    const effort = scoreEffort(task.task);
    const aiScore = Math.round(urgency * 0.5 + importance * 0.35 + effort * 0.15);
    const adjustedScore = applyAdaptiveWeights({ urgency, importance, effort }, weights);

    const missingQs = [];
    for (const field of task.missing_fields || []) {
      if (field === 'deadline') missingQs.push(`When is '${task.task}' due?`);
      else if (field === 'assigned_by') missingQs.push(`Who assigned '${task.task}'?`);
    }

    const isBlocked = blocked.has(task.id);

    let decision, status;
    if (missingQs.length) {
      decision = 'ask_user';
      status = 'blocked_waiting_info';
    } else if (isBlocked) {
      decision = 'waiting';
      status = 'pending';
    } else if (adjustedScore >= 80) {
      decision = 'do_now';
      status = 'pending';
    } else if (adjustedScore >= 50) {
      decision = 'schedule';
      status = 'pending';
    } else {
      decision = 'defer';
      status = 'pending';
    }

    return {
      task_id: task.id,
      priority_score: adjustedScore,
      ai_priority_score: aiScore,
      user_adjusted_score: adjustedScore,
      decision,
      steps: [],
      conflicts: conflictMsgMap[task.id] || [],
      missing_info_questions: missingQs,
      status,
      complexity: task.complexity || null,
    };
  });

  plans.sort((a, b) => b.priority_score - a.priority_score);
  return { plans, conflicts };
}

export async function planTasks(tasks, now, onProgress, options = {}) {
  onProgress?.(`Detecting conflicts across ${tasks.length} task(s)…`);
  const { plans, conflicts } = scorePlan(tasks, now, options);

  onProgress?.(`Generating step-by-step plans and dependency hints…`);
  const ai = await generatePlanAI(tasks, { weightsSummary: options.weightsSummary });
  if (ai.degraded) {
    onProgress?.(`AI plan step degraded: ${ai.error}. Using deterministic scoring only.`);
  }

  const planMap = Object.fromEntries(plans.map((p) => [p.task_id, p]));
  for (const t of tasks) {
    const p = planMap[t.id];
    if (!p) continue;
    const steps = Array.isArray(ai.steps_by_id[t.id]) ? ai.steps_by_id[t.id] : [];
    p.steps = steps.filter((s) => typeof s === 'string' && s.trim()).slice(0, 7);
    const comp = ai.complexity_by_id[t.id];
    if (['simple', 'moderate', 'complex'].includes(comp)) p.complexity = comp;
  }

  return { plans, conflicts, dependencies: ai.dependencies || [], ai_degraded: !!ai.degraded };
}
