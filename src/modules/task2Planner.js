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

async function generateStepsBatch(tasks) {
  if (!tasks.length) return {};
  const client = getClient();
  const taskList = tasks.map((t) => `ID: ${t.id}\nTask: ${t.task}`).join('\n\n');
  const response = await withRetry(() =>
    client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'Generate 3-5 concrete, actionable steps for each task. Output ONLY valid JSON, no markdown: {"steps_by_id": {"t1": ["step 1", "step 2", ...], "t2": [...]}}',
        },
        { role: 'user', content: `Generate steps for these tasks:\n\n${taskList}` },
      ],
    })
  );
  const content = response.choices?.[0]?.message?.content || '';
  const data = extractJson(content);
  return data.steps_by_id && typeof data.steps_by_id === 'object' ? data.steps_by_id : {};
}

function detectConflicts(tasks) {
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
          ids: [t1.id, t2.id],
          message: `Deadline clash: '${t1.task}' and '${t2.task}' are due within ${Math.round(diffHours * 60)} minutes of each other. Recommend prioritizing '${winner.task}' first (${reason}).`,
        });
      }
    }
  }
  return conflicts;
}

export async function planTasks(tasks, now, onProgress) {
  onProgress?.(`Detecting deadline conflicts across ${tasks.length} task(s)…`);
  const conflicts = detectConflicts(tasks);
  const conflictMsgMap = {};
  for (const c of conflicts) {
    for (const tid of c.ids) {
      (conflictMsgMap[tid] ||= []).push(c.message);
    }
  }

  onProgress?.(`Generating step-by-step plans for ${tasks.length} task(s)…`);
  const stepsById = await generateStepsBatch(tasks);

  const plans = tasks.map((task) => {
    const urgency = scoreUrgency(task.deadline_iso, now);
    const importance = scoreImportance(task.assigned_by, task.priority);
    const effort = scoreEffort(task.task);
    const priorityScore = Math.round(urgency * 0.5 + importance * 0.35 + effort * 0.15);

    const missingQs = [];
    for (const field of task.missing_fields) {
      if (field === 'deadline') missingQs.push(`When is '${task.task}' due?`);
      else if (field === 'assigned_by') missingQs.push(`Who assigned '${task.task}'?`);
    }

    let decision, status;
    if (missingQs.length) {
      decision = 'ask_user';
      status = 'blocked_waiting_info';
    } else if (priorityScore >= 80) {
      decision = 'do_now';
      status = 'pending';
    } else if (priorityScore >= 50) {
      decision = 'schedule';
      status = 'pending';
    } else {
      decision = 'defer';
      status = 'pending';
    }

    return {
      task_id: task.id,
      priority_score: priorityScore,
      decision,
      steps: stepsById[task.id] || [],
      conflicts: conflictMsgMap[task.id] || [],
      missing_info_questions: missingQs,
      status,
    };
  });

  plans.sort((a, b) => b.priority_score - a.priority_score);
  return { plans, conflicts };
}
