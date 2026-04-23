const HOUR = 3_600_000;

export function computeSchedule(task, plan, now = new Date()) {
  if (!task?.deadline_iso) return [];
  const deadline = new Date(task.deadline_iso);
  if (isNaN(deadline.getTime())) return [];
  const hoursUntil = (deadline.getTime() - now.getTime()) / HOUR;
  if (hoursUntil <= 0) return [];

  const complexity = task.complexity || plan?.complexity || 'moderate';

  const tiers = {
    simple: [1],
    moderate: [24, 1],
    complex: [72, 24, 4, 1],
  };

  const decision = plan?.decision || 'schedule';
  let offsets;
  if (decision === 'do_now') offsets = [...(tiers[complexity] || tiers.moderate), 1];
  else if (decision === 'schedule') offsets = tiers[complexity] || tiers.moderate;
  else offsets = [24];

  offsets = [...new Set(offsets)].sort((a, b) => b - a);

  const out = [];
  const seen = new Set();
  for (const offset of offsets) {
    if (offset >= hoursUntil) continue;
    const fireAt = new Date(deadline.getTime() - offset * HOUR);
    if (fireAt.getTime() <= now.getTime()) continue;
    const iso = fireAt.toISOString();
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push({
      fire_at_iso: iso,
      hours_before: offset,
      message: `Reminder: '${task.task}' due in ${offset}h (${complexity} task)`,
    });
  }
  return out;
}
