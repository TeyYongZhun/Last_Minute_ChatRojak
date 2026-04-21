import { loadState, saveState } from '../state.js';

function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mergeTasksAndPlans(newTasks, newPlans /*, conflicts */) {
  const state = loadState();
  const existingTaskIds = new Set(state.tasks.map((t) => t.id));

  for (const task of newTasks) {
    if (existingTaskIds.has(task.id)) {
      state.tasks = state.tasks.map((t) => (t.id === task.id ? task : t));
      state.replan_events.push(`[${ts()}] Task ${task.id} replanned.`);
    } else {
      state.tasks.push(task);
    }
  }

  const existingPlanIds = new Set(state.plans.map((p) => p.task_id));
  for (const plan of newPlans) {
    if (existingPlanIds.has(plan.task_id)) {
      state.plans = state.plans.map((p) => (p.task_id === plan.task_id ? plan : p));
    } else {
      state.plans.push(plan);
    }
  }

  saveState(state);
}

export function completeTask(taskId) {
  const state = loadState();
  let found = false;
  for (const task of state.tasks) {
    if (task.id === taskId) {
      task.status = 'done';
      found = true;
    }
  }
  for (const plan of state.plans) {
    if (plan.task_id === taskId) plan.status = 'done';
  }
  if (found) {
    state.replan_events.push(`[${ts()}] Task ${taskId} marked done.`);
    saveState(state);
  }
  return found;
}

export function respondToClarification(taskId, field, value) {
  const state = loadState();
  let found = false;
  for (const task of state.tasks) {
    if (task.id === taskId) {
      if (field === 'deadline') task.deadline = value;
      else if (field === 'assigned_by') task.assigned_by = value;
      task.missing_fields = (task.missing_fields || []).filter((f) => f !== field);
      if (!task.missing_fields.length) task.status = 'pending';
      found = true;
    }
  }
  if (found) {
    state.replan_events.push(`[${ts()}] Clarification for ${taskId} (${field}): '${value}'.`);
    saveState(state);
  }
  return found;
}

export function getDashboard() {
  const state = loadState();
  const taskMap = Object.fromEntries(state.tasks.map((t) => [t.id, t]));

  const do_now = [];
  const schedule = [];
  const defer = [];
  const need_info = [];
  const done = [];

  const sortedPlans = [...state.plans].sort((a, b) => b.priority_score - a.priority_score);
  for (const plan of sortedPlans) {
    const task = taskMap[plan.task_id];
    if (!task) continue;
    const item = {
      task_id: task.id,
      task: task.task,
      deadline: task.deadline,
      deadline_iso: task.deadline_iso,
      assigned_by: task.assigned_by,
      priority: task.priority,
      priority_score: plan.priority_score,
      decision: plan.decision,
      steps: plan.steps,
      conflicts: plan.conflicts,
      missing_info_questions: plan.missing_info_questions,
      status: task.status,
      confidence: task.confidence,
    };
    if (task.status === 'done') done.push(item);
    else if (plan.decision === 'ask_user') need_info.push(item);
    else if (plan.decision === 'do_now') do_now.push(item);
    else if (plan.decision === 'schedule') schedule.push(item);
    else defer.push(item);
  }

  return {
    do_now,
    schedule,
    defer,
    need_info,
    done,
    replan_events: state.replan_events.slice(-15),
    total_tasks: state.tasks.length,
  };
}
