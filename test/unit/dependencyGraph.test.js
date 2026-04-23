import { describe, it, expect } from 'vitest';
import { hasCycle, topoSort } from '../../src/modules/dependencyGraph.js';

describe('dependencyGraph', () => {
  it('detects cycles', () => {
    const edges = [
      { task_id: 'a', depends_on: 'b' },
      { task_id: 'b', depends_on: 'c' },
      { task_id: 'c', depends_on: 'a' },
    ];
    expect(hasCycle(edges)).toBe(true);
  });

  it('accepts a DAG', () => {
    const edges = [
      { task_id: 'a', depends_on: 'b' },
      { task_id: 'b', depends_on: 'c' },
    ];
    expect(hasCycle(edges)).toBe(false);
  });

  it('detects cycle when adding a new edge', () => {
    const existing = [
      { task_id: 'a', depends_on: 'b' },
      { task_id: 'b', depends_on: 'c' },
    ];
    const newEdge = { task_id: 'c', depends_on: 'a' };
    expect(hasCycle(existing, newEdge)).toBe(true);
  });

  it('topo-sorts a valid DAG', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [{ task_id: 'a', depends_on: 'b' }, { task_id: 'b', depends_on: 'c' }];
    const order = topoSort(tasks, edges);
    expect(order).not.toBeNull();
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
  });

  it('returns null for a cyclic graph', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }];
    const edges = [{ task_id: 'a', depends_on: 'b' }, { task_id: 'b', depends_on: 'a' }];
    expect(topoSort(tasks, edges)).toBeNull();
  });

  it('filters edges referencing unknown tasks', () => {
    const tasks = [{ id: 'a' }];
    const edges = [{ task_id: 'a', depends_on: 'unknown' }];
    const order = topoSort(tasks, edges);
    expect(order).toEqual(['a']);
  });
});
