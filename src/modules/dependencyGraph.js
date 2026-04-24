import {
  listDependencies,
  getDependenciesFor,
  getDependentsOf,
  addDependency,
  removeDependency,
  removeAllFor,
} from '../db/repos/dependencies.js';

export function buildAdjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.task_id)) adj.set(e.task_id, []);
    if (!adj.has(e.depends_on)) adj.set(e.depends_on, []);
    adj.get(e.task_id).push(e.depends_on);
  }
  return adj;
}

export function hasCycle(edges, extra = null) {
  const all = extra ? [...edges, extra] : edges;
  const adj = buildAdjacency(all);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const node of adj.keys()) color.set(node, WHITE);

  function dfs(node) {
    if (color.get(node) === GRAY) return true;
    if (color.get(node) === BLACK) return false;
    color.set(node, GRAY);
    for (const nxt of adj.get(node) || []) {
      if (dfs(nxt)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const node of adj.keys()) {
    if (dfs(node)) return true;
  }
  return false;
}

export function topoSort(tasks, edges) {
  const ids = new Set(tasks.map((t) => t.id));
  const filtered = edges.filter((e) => ids.has(e.task_id) && ids.has(e.depends_on));
  // Reverse adjacency: for edge task -> depends_on, depends_on points to tasks that depend on it.
  const revAdj = new Map();
  for (const id of ids) revAdj.set(id, []);
  const indeg = new Map();
  for (const id of ids) indeg.set(id, 0);
  for (const e of filtered) {
    indeg.set(e.task_id, (indeg.get(e.task_id) || 0) + 1);
    revAdj.get(e.depends_on).push(e.task_id);
  }

  const q = [];
  for (const [id, d] of indeg) if (d === 0) q.push(id);

  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const dependent of revAdj.get(id) || []) {
      indeg.set(dependent, (indeg.get(dependent) || 0) - 1);
      if (indeg.get(dependent) === 0) q.push(dependent);
    }
  }

  if (order.length !== ids.size) return null;
  return order;
}

export function safelyAddDependency(userId, taskId, dependsOn, reason = null) {
  const existing = listDependencies(userId);
  if (hasCycle(existing, { task_id: taskId, depends_on: dependsOn })) {
    const err = new Error('Adding this dependency would create a cycle');
    err.code = 'CYCLE';
    throw err;
  }
  addDependency(userId, taskId, dependsOn, reason);
}

export function safelyAddMany(userId, proposed, knownTaskIds) {
  const existing = listDependencies(userId);
  const added = [];
  const rejected = [];
  const current = [...existing];
  for (const edge of proposed || []) {
    if (!edge?.task_id || !edge?.depends_on) continue;
    if (edge.task_id === edge.depends_on) {
      rejected.push({ ...edge, reason: 'self-loop' });
      continue;
    }
    if (knownTaskIds && !(knownTaskIds.has(edge.task_id) && knownTaskIds.has(edge.depends_on))) {
      rejected.push({ ...edge, reason: 'unknown_task' });
      continue;
    }
    if (hasCycle(current, { task_id: edge.task_id, depends_on: edge.depends_on })) {
      rejected.push({ ...edge, reason: 'cycle' });
      continue;
    }
    addDependency(userId, edge.task_id, edge.depends_on, edge.reason || null);
    current.push({ task_id: edge.task_id, depends_on: edge.depends_on });
    added.push(edge);
  }
  return { added, rejected };
}

export function blockedTaskIds(userId, doneIds) {
  const edges = listDependencies(userId);
  const done = doneIds instanceof Set ? doneIds : new Set(doneIds || []);
  const blocked = new Set();
  for (const e of edges) {
    if (!done.has(e.depends_on)) blocked.add(e.task_id);
  }
  return blocked;
}

export { removeDependency, removeAllFor, listDependencies, addDependency, getDependenciesFor, getDependentsOf };
