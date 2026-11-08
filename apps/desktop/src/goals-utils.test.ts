import { describe, expect, it } from 'vitest';
import type { PlanView, Task } from './api';
import {
  columnItems,
  containsPeriod,
  isoWeek,
  joinPeriod,
  parentOptions,
  periodLabel,
  periodsAt,
  periodsFromAny,
  periodsOfYmd,
  select,
  splitPeriod,
  taskColumn,
  weekGoalOptions,
  weekRange,
  weeksInYear,
  yearOptions,
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
  alignedGoalId: null,
  criteria: [],
  helps: [],
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

describe('taskColumn（D46）', () => {
  const task = (id: string, dueAt: number | null, extra: Partial<Task> = {}): Task => ({
    id,
    team: 'g',
    planItemId: null,
    title: id,
    assignee: 'me',
    status: 'todo',
    dueAt,
    steps: [],
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });
  // 2026-W46 = 11/9–11/15
  const mon = Date.UTC(2026, 10, 9, 3);
  const list = [
    task('a', mon),
    task('b', mon + 7 * 86_400_000),
    task('c', null),
    task('d', mon, { status: 'done' }),
    task('e', mon, { assignee: 'other' }),
    task('f', mon + 8 * 86_400_000, { assignee: 'other' }),
    task('g', mon, { planItemId: 'w1', status: 'done' }),
    task('h', null, { planItemId: 'w1' }),
  ];
  const opts = { week: '2026-W46', selectedWeek: null, me: 'me', focusId: 'f', tz: 'UTC' };
  it('未選取週目標：本週或沒有期限、指派給我、未完成，加上焦點', () => {
    expect(taskColumn(list, opts).map((t) => t.id)).toEqual(['a', 'f', 'c', 'h']);
  });
  it('選取週目標：連結到它的任務，已完成排最後', () => {
    expect(taskColumn(list, { ...opts, selectedWeek: 'w1' }).map((t) => t.id)).toEqual(['h', 'g']);
  });
});

describe('期間選擇器（ui-spec「目標」v0.17）', () => {
  it('yearOptions：前 1 年到後 2 年，含目前值', () => {
    expect(yearOptions(2026)).toEqual([2025, 2026, 2027, 2028]);
    expect(yearOptions(2026, 2020)).toEqual([2020, 2025, 2026, 2027, 2028]);
    expect(yearOptions(2026, 2027)).toEqual([2025, 2026, 2027, 2028]);
  });
  it('weeksInYear：53 週的年份', () => {
    expect(weeksInYear(2020)).toBe(53);
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2025)).toBe(52);
    expect(weeksInYear(2027)).toBe(52);
  });
  it('weekRange：週一到週日，可跨年', () => {
    expect(weekRange(2026, 45)).toEqual({
      start: { y: 2026, m: 11, d: 2 },
      end: { y: 2026, m: 11, d: 8 },
    });
    expect(weekRange(2026, 1).start).toEqual({ y: 2025, m: 12, d: 29 });
    expect(weekRange(2026, 53).end).toEqual({ y: 2027, m: 1, d: 3 });
  });
  it('splitPeriod / joinPeriod 互為反函式', () => {
    const cases: [PlanView['level'], string][] = [
      ['year', '2026'],
      ['quarter', '2026-Q4'],
      ['month', '2026-03'],
      ['week', '2026-W05'],
    ];
    for (const [level, p] of cases) {
      const { year, n } = splitPeriod(level, p);
      expect(joinPeriod(level, year, n)).toBe(p);
    }
  });
  it('joinPeriod：週次超過該年週數時夾到最後一週', () => {
    expect(joinPeriod('week', 2027, 53)).toBe('2027-W52');
  });
  it('periodsFromAny：換層級時取原期間的第一天', () => {
    expect(periodsFromAny('2026-Q4', 'quarter').month).toBe('2026-10');
    expect(periodsFromAny('2026-W01', 'week').day).toBe('2025-12-29');
    expect(periodsFromAny('2026-11-09', 'day').week).toBe('2026-W46');
    expect(periodsFromAny('2026', 'year').quarter).toBe('2026-Q1');
  });
  it('periodsFromAny：原期間包含錨點日時用錨點日所在的期間', () => {
    const anchor = periodsOfYmd(2026, 11, 9);
    expect(periodsFromAny('2026', 'year', anchor).quarter).toBe('2026-Q4');
    expect(periodsFromAny('2026-Q4', 'quarter', anchor).week).toBe('2026-W46');
    expect(periodsFromAny('2026-Q1', 'quarter', anchor).month).toBe('2026-01');
  });
});

describe('weekGoalOptions（D46）', () => {
  it('負責人的週目標：本週與之後由近到遠，接著之前由近到遠', () => {
    const items = [
      plan('a', 'week', '2026-W44'),
      plan('b', 'week', '2026-W47'),
      plan('c', 'week', '2026-W46'),
      plan('d', 'week', '2026-W45'),
      plan('e', 'month', '2026-11'),
      { ...plan('f', 'week', '2026-W46'), owner: 'other' },
    ];
    expect(weekGoalOptions(items, 'me', '2026-W46').map((p) => p.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});
