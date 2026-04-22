import { getDb } from '../db/index.js';
import { insertTask, setTaskTags } from '../db/repos/tasks.js';
import { upsertPlan } from '../db/repos/plans.js';
import { replaceChecklist } from '../db/repos/checklists.js';
import { addNotification } from '../db/repos/notifications.js';
import { addReplanEvent } from '../db/repos/replanEvents.js';
import { resetUser } from './task3Executor.js';

function atIso(base, dayOffset, hour, minute) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function daysUntilFriday(now) {
  const dow = now.getDay();
  const diff = (5 - dow + 7) % 7;
  return diff === 0 ? 7 : diff;
}

export function seedDemo(userId) {
  const now = new Date();
  const fri = daysUntilFriday(now);

  const t1_iso = atIso(now, fri, 23, 59);
  const t2_iso = atIso(now, 1, 12, 0);

  const tasks = [
    {
      id: 't1',
      task: 'Submit Assignment 2',
      deadline: 'Friday 11:59pm',
      deadline_iso: t1_iso,
      assigned_by: 'Dr. Rahman',
      priority: 'high',
      confidence: 0.95,
      missing_fields: [],
      category: 'Academic',
      tags: ['urgent', 'solo'],
      status: 'pending',
    },
    {
      id: 't2',
      task: 'Help with lab report',
      deadline: 'tomorrow noon',
      deadline_iso: t2_iso,
      assigned_by: 'Emma',
      priority: 'medium',
      confidence: 0.85,
      missing_fields: [],
      category: 'Academic',
      tags: ['group-work', 'short'],
      status: 'pending',
    },
    {
      id: 't3',
      task: 'Volunteer for CS Society event',
      deadline: null,
      deadline_iso: null,
      assigned_by: 'CS Society',
      priority: 'medium',
      confidence: 0.7,
      missing_fields: ['deadline'],
      category: 'CCA event',
      tags: ['group-work', 'waiting-on-others'],
      status: 'blocked_waiting_info',
    },
  ];

  const plans = [
    {
      task_id: 't1',
      priority_score: 88,
      decision: 'do_now',
      steps: ['Review requirements', 'Finalize draft', 'Submit via portal', 'Verify confirmation'],
      conflicts: [],
      missing_info_questions: [],
      status: 'pending',
    },
    {
      task_id: 't2',
      priority_score: 62,
      decision: 'schedule',
      steps: ['Ask Emma for current draft', 'Review lab data', 'Draft sections together'],
      conflicts: [],
      missing_info_questions: [],
      status: 'pending',
    },
    {
      task_id: 't3',
      priority_score: 35,
      decision: 'ask_user',
      steps: [],
      conflicts: [],
      missing_info_questions: ["When is 'Volunteer for CS Society event' due?"],
      status: 'blocked_waiting_info',
    },
  ];

  const db = getDb();
  const tx = db.transaction(() => {
    resetUser(userId);
    for (const t of tasks) {
      insertTask(userId, t);
      setTaskTags(t.id, t.tags || []);
    }
    for (const p of plans) upsertPlan(userId, p);
    replaceChecklist('t1', plans[0].steps);
    replaceChecklist('t2', plans[1].steps);

    addNotification(userId, {
      type: 'reminder',
      task_id: 't2',
      message: "Reminder: 'Help with lab report' due in 24h",
      fired_at_iso: now.toISOString(),
    });

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    addReplanEvent(userId, `[${hh}:${mm}] t1 planned (priority 88, decision do_now)`);
    addReplanEvent(userId, `[${hh}:${mm}] t2 planned (priority 62, decision schedule)`);
    addReplanEvent(userId, `[${hh}:${mm}] t3 planned (priority 35, decision ask_user)`);
    addReplanEvent(userId, `[${hh}:${mm}] Reminder fired for t2`);
  });
  tx();
}
