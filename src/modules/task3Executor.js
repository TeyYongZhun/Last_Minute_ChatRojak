import { loadState, saveState } from '../state.js';
import { planTasks } from './task2Planner.js';
import {
  generateActionsForPlan,
  pruneActionsForTask,
  sweepDueReminders,
  toggleChecklistItem,
  getChecklist,
} from './actions.js';
import { emit } from './notifier.js';

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mergeNewTasks(newTasks) {
  const state = loadState();
  const existingTaskIds = new Set(state.tasks.map((t) => t.id));
  let maxId = 0;
  for (const t of state.tasks) {
    const m = /^t(\d+)$/.exec(t.id || '');
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }

  for (const task of newTasks) {
    if (existingTaskIds.has(task.id)) {
      maxId += 1;
      task.id = `t${maxId}`;
    }
    state.tasks.push(task);
    existingTaskIds.add(task.id);
  }

  saveState(state);
}

export async function replanAll(now = new Date()) {
  const state = loadState();
  const openTasks = state.tasks.filter((t) => t.status !== 'done');
  if (!openTasks.length) {
    sweepDueReminders(state, now);
    saveState(state);
    return { plans: [], conflicts: [] };
  }

  const prevPlansById = Object.fromEntries(state.plans.map((p) => [p.task_id, p]));
  const { plans, conflicts } = await planTasks(openTasks, now);

  const taskById = Object.fromEntries(openTasks.map((t) => [t.id, t]));
  for (const plan of plans) {
    const prev = prevPlansById[plan.task_id];
    if (prev) {
      const delta = plan.priority_score - prev.priority_score;
      if (Math.abs(delta) >= 10 || prev.decision !== plan.decision) {
        state.replan_events.push(
          `[${ts(now)}] ${plan.task_id} priority ${prev.priority_score} → ${plan.priority_score}, decision ${prev.decision} → ${plan.decision}`
        );
      }
    } else {
      state.replan_events.push(
        `[${ts(now)}] ${plan.task_id} planned (priority ${plan.priority_score}, decision ${plan.decision})`
      );
    }

    const task = taskById[plan.task_id];
    if (task?.status === 'in_progress') {
      plan.status = 'in_progress';
    }

    if (task) generateActionsForPlan(state, plan, task, now);

    if (plan.decision === 'ask_user' && Array.isArray(plan.missing_info_questions) && plan.missing_info_questions.length) {
      const prevQs = new Set((prev?.missing_info_questions || []));
      const newQs = plan.missing_info_questions.filter((q) => !prevQs.has(q));
      if (newQs.length) {
        emit('clarification_needed', {
          task_id: plan.task_id,
          task: task?.task || plan.task_id,
          questions: newQs,
          missing_fields: task?.missing_fields || [],
        });
      }
    }
  }

  const openIds = new Set(openTasks.map((t) => t.id));
  const updatedPlans = state.plans.map((p) => {
    if (!openIds.has(p.task_id)) return p;
    return plans.find((np) => np.task_id === p.task_id) || p;
  });
  for (const np of plans) {
    if (!updatedPlans.some((p) => p.task_id === np.task_id)) updatedPlans.push(np);
  }
  state.plans = updatedPlans;

  for (const c of conflicts) {
    const key = `conflict:${c.ids.sort().join('|')}`;
    if (!state.replan_events.some((e) => e.includes(key))) {
      state.replan_events.push(`[${ts(now)}] ${key} — ${c.message}`);
      emit('conflict', { key, ids: c.ids, message: c.message });
    }
  }

  sweepDueReminders(state, now);
  saveState(state);
  return { plans, conflicts };
}

export function startTask(taskId) {
  const state = loadState();
  let found = false;
  for (const task of state.tasks) {
    if (task.id === taskId && task.status !== 'done') {
      task.status = 'in_progress';
      found = true;
    }
  }
  for (const plan of state.plans) {
    if (plan.task_id === taskId && plan.status !== 'done') plan.status = 'in_progress';
  }
  if (found) {
    state.replan_events.push(`[${ts()}] Task ${taskId} started.`);
    saveState(state);
  }
  return found;
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
    pruneActionsForTask(state, taskId);
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

export function toggleStep(taskId, stepIndex) {
  const state = loadState();
  if (!toggleChecklistItem(state, taskId, stepIndex)) return false;
  saveState(state);
  return true;
}

export function getDashboard() {
  const now = new Date();
  const state = loadState();
  sweepDueReminders(state, now);
  saveState(state);

  const taskMap = Object.fromEntries(state.tasks.map((t) => [t.id, t]));

  const do_now = [];
  const in_progress = [];
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
      checklist: getChecklist(state, task.id),
      conflicts: plan.conflicts,
      missing_info_questions: plan.missing_info_questions,
      status: task.status,
      confidence: task.confidence,
    };
    if (task.status === 'done') done.push(item);
    else if (task.status === 'in_progress') in_progress.push(item);
    else if (plan.decision === 'ask_user') need_info.push(item);
    else if (plan.decision === 'do_now') do_now.push(item);
    else if (plan.decision === 'schedule') schedule.push(item);
    else defer.push(item);
  }

  return {
    do_now,
    in_progress,
    schedule,
    defer,
    need_info,
    done,
    notifications: (state.notifications || []).slice(-10).reverse(),
    replan_events: state.replan_events.slice(-15),
    total_tasks: state.tasks.length,
  };
}
