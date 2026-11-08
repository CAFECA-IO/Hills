import { describe, expect, it } from 'vitest';
import type { PlanView, Task } from './api';
import {
  columnItems,
  containsPeriod,
  isoWeek,
  parentOptions,
  periodLabel,
  periodsAt,
  periodsOfYmd,
  select,
  todayTasks,
} from './goals-utils';

const plan = (
  id: string,
  level: PlanView['level'],
  period: string,
  parentId: string | null = null,
): PlanView => ({
  id,
  owner: 'me',
  visibility: { kind: 'org' },
  level,
  period,
  title: id,
  parentId,
  krRef: null,
  done: false,
  progressOverride: null,
  keyResults: [],
  createdAt: 0,
  updatedAt: 0,
  progress: 0,
  krProgress: {},
  mine: true,
});

describe('periods', () => {
  it('computes ISO weeks across year boundaries', () => {
    expect(isoWeek(2026, 12, 31)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(2027, 1, 1)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(2027, 1, 4)).toEqual({ year: 2027, week: 1 });
    expect(isoWeek(2026, 11, 8)).toEqual({ year: 2026, week: 45 });
    expect(isoWeek(2025, 12, 29)).toEqual({ year: 2026, week: 1 });
  });
  it('builds the five period strings', () => {
    expect(periodsOfYmd(2026, 11, 8)).toEqual({
      year: '2026',
      quarter: '2026-Q4',
      month: '2026-11',
      week: '2026-W45',
      day: '2026-11-08',
    });
  });
  it('uses the organisation time zone', () => {
    // 2026-11-07 20:00 UTC = 2026-11-08 04:00 台北
    const ms = Date.UTC(2026, 10, 7, 20);
    expect(periodsAt(ms, 'Asia/Taipei').day).toBe('2026-11-08');
    expect(periodsAt(ms, 'UTC').day).toBe('2026-11-07');
    expect(periodsAt(ms, 'Not/AZone').day).toMatch(/^2026-11-0[78]$/);
  });
  it('labels periods', () => {
    expect(periodLabel('quarter', '2026-Q4')).toBe('Q4');
    expect(periodLabel('month', '2026-03')).toBe('3');
    expect(periodLabel('week', '2026-W05')).toBe('W05');
    expect(periodLabel('day', '2026-11-08')).toBe('11/8');
  });
  it('checks containment, weeks belong where their Thursday is', () => {
    expect(containsPeriod('2026-Q4', 'quarter', '2026-11', 'month')).toBe(true);
    expect(containsPeriod('2026-11', 'month', '2026-W45', 'week')).toBe(true);
    expect(containsPeriod('2026', 'year', '2026-W53', 'week')).toBe(true);
    expect(containsPeriod('2027', 'year', '2026-W53', 'week')).toBe(false);
    expect(containsPeriod('2026-W45', 'week', '2026-11-08', 'day')).toBe(true);
    expect(containsPeriod('2026-W45', 'week', '2026-11-09', 'day')).toBe(false);
  });
});

describe('selection', () => {
  const p = periodsOfYmd(2026, 11, 8);
  const items = [
    plan('y1', 'year', '2026'),
    plan('q1', 'quarter', '2026-Q4', 'y1'),
    plan('q2', 'quarter', '2026-Q4', 'y2'),
    plan('q3', 'quarter', '2026-Q3', 'y1'),
    plan('m1', 'month', '2026-11', 'q1'),
  ];
  it('filters the next column by the selected parent', () => {
    expect(columnItems(items, 'quarter', p, {}).map((i) => i.id)).toEqual(['q1', 'q2']);
    expect(columnItems(items, 'quarter', p, { year: 'y1' }).map((i) => i.id)).toEqual(['q1']);
    expect(columnItems(items, 'month', p, { year: 'y1' }).map((i) => i.id)).toEqual(['m1']);
  });
  it('clears deeper levels when selecting', () => {
    expect(select({ year: 'y1', quarter: 'q1', month: 'm1' }, 'quarter', 'q2')).toEqual({
      year: 'y1',
      quarter: 'q2',
    });
    expect(select({ year: 'y1', quarter: 'q1' }, 'year', null)).toEqual({});
  });
  it('offers parents from the containing upper period', () => {
    expect(parentOptions(items, 'month', '2026-11').map((i) => i.id)).toEqual(['q1', 'q2']);
    expect(parentOptions(items, 'year', '2026')).toEqual([]);
  });
});

describe('todayTasks', () => {
  const task = (id: string, dueAt: number | null, status: Task['status'] = 'todo'): Task => ({
    id,
    team: 'g',
    title: id,
    assignee: null,
    status,
    dueAt,
    steps: [],
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
  });
  it('keeps tasks due today or the focus, not done', () => {
    const today = Date.UTC(2026, 10, 8, 3);
    const list = [
      task('a', today),
      task('b', today + 86_400_000),
      task('c', null),
      task('d', today, 'done'),
    ];
    expect(todayTasks(list, 'c', '2026-11-08', 'UTC').map((t) => t.id)).toEqual(['a', 'c']);
  });
});
