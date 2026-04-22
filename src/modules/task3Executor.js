import { getDb } from '../db/index.js';
import { planTasks } from './task2Planner.js';
import {
  generateActionsForPlan,
  pruneActionsForTask,
  sweepDueReminders,
} from './actions.js';
import { emit } from './notifier.js';
import {
  listTasks,
  listOpenTasks,
  getTask,
  nextTaskId,
  insertTask,
  updateTaskStatus,
  updateTaskField,
  updateTaskMissingFields,
  setTaskTags,
  getTagsForTasks,
  listTagCounts,
  deleteAllForUser,
} from '../db/repos/tasks.js';
import {
  listPlans,
  getPlan,
  upsertPlan,
  updatePlanStatus,
} from '../db/repos/plans.js';
import {
  toggleChecklistItem,
  getChecklist,
} from '../db/repos/checklists.js';
import { listRecent as listRecentNotifications } from '../db/repos/notifications.js';
import { listRecent as listRecentReplanEvents, addReplanEvent, hasEventContaining } from '../db/repos/replanEvents.js';

function ts(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function mergeNewTasks(userId, newTasks) {
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = new Set(listTasks(userId).map((t) => t.id));
    let nextIdNum = (() => {
      let maxN = 0;
      for (const id of existing) {
        const m = /^t(\d+)$/.exec(id);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      return maxN;
    })();

    for (const task of newTasks) {
      const t = { ...task };
      if (!t.id || existing.has(t.id)) {
        nextIdNum += 1;
        t.id = `t${nextIdNum}`;
      } else {
        const m = /^t(\d+)$/.exec(t.id);
        if (m) nextIdNum = Math.max(nextIdNum, Number(m[1]));
      }
      insertTask(userId, t);
      setTaskTags(t.id, t.tags || []);
      existing.add(t.id);
    }
  });
  tx();
}

export async function replanAll(userId, now = new Date(), onProgress) {
  const openTasks = listOpenTasks(userId);
  if (!openTasks.length) {
    return { plans: [], conflicts: [] };
  }

  const prevPlans = listPlans(userId);
  const prevById = Object.fromEntries(prevPlans.map((p) => [p.task_id, p]));

  const { plans, conflicts } = await planTasks(openTasks, now, onProgress);

  const db = getDb();
  const tx = db.transaction(() => {
    for (const plan of plans) {
      const prev = prevById[plan.task_id];
      if (prev) {
        const delta = plan.priority_score - prev.priority_score;
        if (Math.abs(delta) >= 10 || prev.decision !== plan.decision) {
          addReplanEvent(
            userId,
            `[${ts(now)}] ${plan.task_id} priority ${prev.priority_score} → ${plan.priority_score}, decision ${prev.decision} → ${plan.decision}`
          );
        }
      } else {
        addReplanEvent(
          userId,
          `[${ts(now)}] ${plan.task_id} planned (priority ${plan.priority_score}, decision ${plan.decision})`
        );
      }

      const task = openTasks.find((t) => t.id === plan.task_id);
      if (task?.status === 'in_progress') plan.status = 'in_progress';

      upsertPlan(userId, plan);
      if (task) generateActionsForPlan(userId, plan, task, now);

      if (
        plan.decision === 'ask_user' &&
        Array.isArray(plan.missing_info_questions) &&
        plan.missing_info_questions.length
      ) {
        const prevQs = new Set(prev?.missing_info_questions || []);
        const newQs = plan.missing_info_questions.filter((q) => !prevQs.has(q));
        if (newQs.length) {
          emit('clarification_needed', {
            user_id: userId,
            task_id: plan.task_id,
            task: task?.task || plan.task_id,
            questions: newQs,
            missing_fields: task?.missing_fields || [],
          });
        }
      }
    }

    for (const c of conflicts) {
      const key = `conflict:${c.ids.slice().sort().join('|')}`;
      if (!hasEventContaining(userId, key)) {
        addReplanEvent(userId, `[${ts(now)}] ${key} — ${c.message}`);
        emit('conflict', { user_id: userId, key, ids: c.ids, message: c.message });
      }
    }
  });
  tx();

  return { plans, conflicts };
}

export function startTask(userId, taskId) {
  const task = getTask(userId, taskId);
  if (!task || task.status === 'done') return false;
  const db = getDb();
  const tx = db.transaction(() => {
    updateTaskStatus(userId, taskId, 'in_progress');
    updatePlanStatus(userId, taskId, 'in_progress');
    addReplanEvent(userId, `[${ts()}] Task ${taskId} started.`);
  });
  tx();
  return true;
}

<<<<<<< HEAD
export function completeTask(userId, taskId) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const db = getDb();
  const tx = db.transaction(() => {
    updateTaskStatus(userId, taskId, 'done');
    updatePlanStatus(userId, taskId, 'done');
    pruneActionsForTask(taskId);
    addReplanEvent(userId, `[${ts()}] Task ${taskId} marked done.`);
  });
  tx();
  return true;
}
=======
export function renameCategory(oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return false;
  const state = loadState();
  let changed = false;
  for (const task of state.tasks) {
    if ((task.category || 'Other') === oldName) {
      task.category = trimmed;
      changed = true;
    }
  }
  if (changed) {
    state.replan_events.push(`[${ts()}] Category renamed: '${oldName}' → '${trimmed}'.`);
    saveState(state);
  }
  return changed;
}

export function getDashboard() {
  const now = new Date();
  const state = loadState();
  sweepDueReminders(state, now);
  saveState(state);
>>>>>>> e2054c5691498fb624e7b834622e5ed51a7843a4

export function respondToClarification(userId, taskId, field, value) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  const db = getDb();
  const tx = db.transaction(() => {
    if (field === 'deadline') {
      updateTaskField(userId, taskId, 'deadline', value);
    } else if (field === 'assigned_by') {
      updateTaskField(userId, taskId, 'assigned_by', value);
    } else if (field === 'deadline_iso') {
      updateTaskField(userId, taskId, 'deadline_iso', value);
    }
    const remaining = (task.missing_fields || []).filter((f) => f !== field);
    updateTaskMissingFields(userId, taskId, remaining);
    if (!remaining.length && task.status === 'blocked_waiting_info') {
      updateTaskStatus(userId, taskId, 'pending');
    }
    addReplanEvent(userId, `[${ts()}] Clarification for ${taskId} (${field}): '${value}'.`);
  });
  tx();
  return true;
}

export function toggleStep(userId, taskId, stepIndex) {
  const task = getTask(userId, taskId);
  if (!task) return false;
  return toggleChecklistItem(taskId, stepIndex);
}

function matchesFilters(task, plan, tags, filters) {
  if (filters.category && (task.category || 'Other').toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.priority && task.priority !== filters.priority) return false;
  if (filters.status) {
    if (filters.status === 'active' && task.status === 'done') return false;
    if (filters.status === 'done' && task.status !== 'done') return false;
    if (!['active', 'done'].includes(filters.status) && task.status !== filters.status) return false;
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    if (!task.task.toLowerCase().includes(needle)) return false;
  }
  if (filters.tags && filters.tags.length) {
    const taskTags = new Set(tags);
    for (const want of filters.tags) {
      if (!taskTags.has(want)) return false;
    }
  }
  return true;
}

export function getDashboard(userId, filters = {}) {
  const tasks = listTasks(userId);
  const taskMap = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const plans = listPlans(userId).sort((a, b) => b.priority_score - a.priority_score);
  const tagsByTask = getTagsForTasks(tasks.map((t) => t.id));

  const do_now = [];
  const in_progress = [];
  const schedule = [];
  const defer = [];
  const need_info = [];
  const done = [];

  for (const plan of plans) {
    const task = taskMap[plan.task_id];
    if (!task) continue;
    const tags = tagsByTask[task.id] || [];
    if (!matchesFilters(task, plan, tags, filters)) continue;
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
      checklist: getChecklist(task.id),
      conflicts: plan.conflicts,
      missing_info_questions: plan.missing_info_questions,
      status: task.status,
      confidence: task.confidence,
      category: task.category || 'Other',
      tags,
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
    notifications: listRecentNotifications(userId, 10),
    replan_events: listRecentReplanEvents(userId, 15),
    total_tasks: tasks.length,
    available_tags: listTagCounts(userId),
    filters_applied: filters,
  };
}

export function resetUser(userId) {
  deleteAllForUser(userId);
}

export { sweepDueReminders };
