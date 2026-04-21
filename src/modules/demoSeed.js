import { saveState } from '../state.js';

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

export function seedDemo() {
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

  const actions = [
    { type: 'checklist', task_id: 't1', items: plans[0].steps.map((s) => ({ step: s, done: false })) },
    { type: 'checklist', task_id: 't2', items: plans[1].steps.map((s) => ({ step: s, done: false })) },
  ];

  const notifications = [
    {
      type: 'reminder',
      task_id: 't2',
      message: "Reminder: 'Help with lab report' due in 24h",
      fired_at_iso: now.toISOString(),
    },
  ];

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const replan_events = [
    `[${hh}:${mm}] t1 planned (priority 88, decision do_now)`,
    `[${hh}:${mm}] t2 planned (priority 62, decision schedule)`,
    `[${hh}:${mm}] t3 planned (priority 35, decision ask_user)`,
    `[${hh}:${mm}] Reminder fired for t2`,
  ];

  saveState({ tasks, plans, replan_events, actions, notifications });
}
