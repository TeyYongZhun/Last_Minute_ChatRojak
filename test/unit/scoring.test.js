import { describe, it, expect } from 'vitest';
import { scoreUrgency, scoreImportance, scoreEffort } from '../../src/modules/task2Planner.js';

describe('scoreUrgency', () => {
  const now = new Date('2026-04-22T12:00:00Z');

  it('returns 20 when no deadline', () => {
    expect(scoreUrgency(null, now)).toBe(20);
  });

  it('returns 20 when deadline is unparseable', () => {
    expect(scoreUrgency('not-a-date', now)).toBe(20);
  });

  it('returns 100 for an overdue deadline', () => {
    const past = new Date(now.getTime() - 3_600_000).toISOString();
    expect(scoreUrgency(past, now)).toBe(100);
  });

  it('returns 95 when <12h away', () => {
    const soon = new Date(now.getTime() + 6 * 3_600_000).toISOString();
    expect(scoreUrgency(soon, now)).toBe(95);
  });

  it('returns 85 when 12-24h away', () => {
    const later = new Date(now.getTime() + 20 * 3_600_000).toISOString();
    expect(scoreUrgency(later, now)).toBe(85);
  });

  it('returns 70 when 24-72h away', () => {
    const later = new Date(now.getTime() + 48 * 3_600_000).toISOString();
    expect(scoreUrgency(later, now)).toBe(70);
  });

  it('returns 50 when 72-168h away', () => {
    const later = new Date(now.getTime() + 100 * 3_600_000).toISOString();
    expect(scoreUrgency(later, now)).toBe(50);
  });

  it('returns 30 when >1 week away', () => {
    const later = new Date(now.getTime() + 200 * 3_600_000).toISOString();
    expect(scoreUrgency(later, now)).toBe(30);
  });
});

describe('scoreImportance', () => {
  it('weights authority figures highest', () => {
    const prof = scoreImportance('Prof Rahman', 'high');
    const classmate = scoreImportance('Classmate Bob', 'high');
    expect(prof).toBeGreaterThan(classmate);
  });

  it('caps at 55', () => {
    expect(scoreImportance('Professor Manager Boss', 'high')).toBeLessThanOrEqual(55);
  });

  it('gives lower score when assigner is unknown', () => {
    const withAssigner = scoreImportance('Emma', 'medium');
    const noAssigner = scoreImportance(null, 'medium');
    expect(withAssigner).toBeGreaterThan(noAssigner);
  });

  it('adds more for high priority than low', () => {
    const high = scoreImportance('Emma', 'high');
    const low = scoreImportance('Emma', 'low');
    expect(high).toBeGreaterThan(low);
  });
});

describe('scoreEffort', () => {
  it('gives the highest score to short task descriptions', () => {
    expect(scoreEffort('Submit form')).toBe(15);
  });

  it('gives medium score for 9-15 word descriptions', () => {
    expect(scoreEffort('Write a short summary of the chapter for the book club')).toBe(10);
  });

  it('gives the lowest score for long descriptions', () => {
    const longDesc = 'Write a comprehensive research paper covering all the historical events leading to the modern era and their impact';
    expect(scoreEffort(longDesc)).toBe(5);
  });
});
