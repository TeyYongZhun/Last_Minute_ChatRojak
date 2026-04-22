import { describe, it, expect } from 'vitest';
import { createUser } from '../../src/db/repos/users.js';
import { listTasks, getTagsForTask } from '../../src/db/repos/tasks.js';
import { mergeNewTasks } from '../../src/modules/task3Executor.js';

function baseTask(partial) {
  return {
    task: 'Some task',
    deadline: null,
    deadline_iso: null,
    assigned_by: null,
    priority: 'medium',
    confidence: 0.9,
    category: 'Academic',
    missing_fields: [],
    status: 'pending',
    tags: [],
    ...partial,
  };
}

describe('mergeNewTasks', () => {
  it('renames colliding task ids rather than overwriting', () => {
    const alice = createUser('alice@x.y', 'hash');
    mergeNewTasks(alice.id, [baseTask({ id: 't1', task: 'First' })]);
    mergeNewTasks(alice.id, [baseTask({ id: 't1', task: 'Second, same id' })]);

    const tasks = listTasks(alice.id);
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2']);
    expect(tasks.find((t) => t.id === 't1').task).toBe('First');
    expect(tasks.find((t) => t.id === 't2').task).toBe('Second, same id');
  });

  it('writes tags and keeps them scoped per task', () => {
    const u = createUser('u@x.y', 'hash');
    mergeNewTasks(u.id, [
      baseTask({ id: 't1', task: 'Task A', tags: ['urgent', 'solo'] }),
      baseTask({ id: 't2', task: 'Task B', tags: ['group-work'] }),
    ]);
    expect(getTagsForTask('t1').sort()).toEqual(['solo', 'urgent']);
    expect(getTagsForTask('t2')).toEqual(['group-work']);
  });

  it('keeps two users\' tasks isolated', () => {
    const alice = createUser('a@x.y', 'hash');
    const bob = createUser('b@x.y', 'hash');
    mergeNewTasks(alice.id, [baseTask({ id: 'ta', task: 'Alice task' })]);
    mergeNewTasks(bob.id, [baseTask({ id: 'tb', task: 'Bob task' })]);

    const aliceTasks = listTasks(alice.id);
    const bobTasks = listTasks(bob.id);
    expect(aliceTasks.map((t) => t.task)).toEqual(['Alice task']);
    expect(bobTasks.map((t) => t.task)).toEqual(['Bob task']);
  });

  it('assigns a fresh id when none is provided', () => {
    const u = createUser('u@x.y', 'hash');
    mergeNewTasks(u.id, [
      baseTask({ id: 't1', task: 'First' }),
      baseTask({ task: 'No id given' }),
    ]);
    const tasks = listTasks(u.id);
    expect(tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('skips near-duplicate open tasks (same text + deadline) on re-import', () => {
    const u = createUser('u@x.y', 'hash');
    mergeNewTasks(u.id, [baseTask({ id: 't1', task: 'Submit CS2100 lab', deadline_iso: '2026-05-01T10:00:00Z' })]);
    mergeNewTasks(u.id, [baseTask({ task: 'submit cs2100 lab!', deadline_iso: '2026-05-01T10:00:00Z' })]);
    mergeNewTasks(u.id, [baseTask({ task: 'Submit CS2100 lab', deadline_iso: '2026-05-01T10:00:00Z' })]);
    const tasks = listTasks(u.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('does not dedupe against completed tasks', () => {
    const u = createUser('u@x.y', 'hash');
    mergeNewTasks(u.id, [baseTask({ id: 't1', task: 'Weekly report', status: 'done' })]);
    mergeNewTasks(u.id, [baseTask({ task: 'Weekly report' })]);
    const tasks = listTasks(u.id);
    expect(tasks).toHaveLength(2);
  });

  it('treats different deadlines as distinct tasks even with same text', () => {
    const u = createUser('u@x.y', 'hash');
    mergeNewTasks(u.id, [
      baseTask({ id: 't1', task: 'Team meeting', deadline_iso: '2026-05-01T10:00:00Z' }),
      baseTask({ id: 't2', task: 'Team meeting', deadline_iso: '2026-05-08T10:00:00Z' }),
    ]);
    const tasks = listTasks(u.id);
    expect(tasks).toHaveLength(2);
  });
});
