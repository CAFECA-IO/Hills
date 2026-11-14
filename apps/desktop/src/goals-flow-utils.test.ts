import { describe, expect, it } from 'vitest';
import type { PlanView, Task } from './api';
import {
  carryInput,
  firstDay,
  lastDay,
  newPlanInput,
  nextStep,
  parentChoices,
  periodOptions,
  reviewItems,
  reviewWindow,
  shiftPeriod,
  suggestChildren,
  titleSuggestions,
  weekCapacity,
  withReview,
} from './goals-flow-utils';
import { periodsOfYmd } from './goals-utils';

const plan = (
  id: string,
  level: PlanView['level'],
  period: string,
  p: Partial<PlanView> = {},
): PlanView => ({
  id,
  owner: 'me',
  visibility: { kind: 'org' },
  level,
  period,
  title: id,
  parentId: null,
  krRef: null,
  done: false,
  progressOverride: null,
  keyResults: [],
  alignedGoalId: null,
  criteria: [],
  helps: [],
  review: null,
  createdAt: 0,
  updatedAt: 0,
  progress: 0,
  krProgress: {},
  mine: true,
  ...p,
});

describe('periods', () => {
  it('shifts each level across year boundaries', () => {
    expect(shiftPeriod('quarter', '2026-Q4', 1)).toBe('2027-Q1');
    expect(shiftPeriod('month', '2026-01', -1)).toBe('2025-12');
    expect(shiftPeriod('week', '2026-W52', 1)).toBe('2026-W53');
    expect(shiftPeriod('week', '2026-W53', 1)).toBe('2027-W01');
    expect(shiftPeriod('year', '2026', -1)).toBe('2025');
  });
  it('knows the first and last day', () => {
    expect(lastDay('quarter', '2026-Q4')).toBe('2026-12-31');
    expect(lastDay('month', '2028-02')).toBe('2028-02-29');
    expect(lastDay('week', '2026-W46')).toBe('2026-11-15');
    expect(firstDay('week', '2026-W46')).toBe('2026-11-09');
    expect(firstDay('month', '2026-12')).toBe('2026-12-01');
  });
});

describe('reviewWindow', () => {
  it('opens in the last 4 days of a month and 7 days of a quarter', () => {
    expect(reviewWindow(periodsOfYmd(2026, 11, 26))).toBeNull();
    expect(reviewWindow(periodsOfYmd(2026, 11, 27))).toEqual({ level: 'month', period: '2026-11' });
    expect(reviewWindow(periodsOfYmd(2026, 12, 25))).toEqual({
      level: 'quarter',
      period: '2026-Q4',
    });
  });
  it('lists unreviewed goals of the period, quarter includes its last month', () => {
    const list = [
      plan('q', 'quarter', '2026-Q4'),
      plan('m', 'month', '2026-12'),
      plan('m2', 'month', '2026-11'),
      plan('r', 'month', '2026-12', {
        review: { outcome: 'achieved', percent: 100, note: '', carriedTo: null, at: 1 },
      }),
    ];
    expect(reviewItems({ level: 'quarter', period: '2026-Q4' }, list).map((p) => p.id)).toEqual([
      'q',
      'm',
    ]);
  });
});

describe('nextStep', () => {
  const now = periodsOfYmd(2026, 11, 16);
  const base = [
    plan('y', 'year', '2026'),
    plan('q', 'quarter', '2026-Q4'),
    plan('m', 'month', '2026-11'),
  ];
  it('asks to plan the year first, then missing quarters and months', () => {
    expect(nextStep(now, [])).toEqual({ kind: 'planYear', year: '2026' });
    expect(nextStep(now, [plan('y', 'year', '2026')])).toMatchObject({
      kind: 'planYear',
      year: '2027',
    });
    const withNext = [...base, plan('y2', 'year', '2027')];
    expect(nextStep(now, withNext)).toEqual({ kind: 'plan', level: 'month', period: '2026-12' });
  });
  it('suggests breaking the month down when next month exists', () => {
    const all = [...base, plan('y2', 'year', '2027'), plan('m12', 'month', '2026-12')];
    expect(nextStep(now, all)).toMatchObject({ kind: 'breakdown', parent: { id: 'm' } });
    expect(nextStep(now, [...all, plan('w', 'week', '2026-W47', { parentId: 'm' })])).toBeNull();
  });
  it('puts the review first in its window and ignores dropped goals', () => {
    const late = periodsOfYmd(2026, 11, 28);
    const all = [...base, plan('y2', 'year', '2027')];
    expect(nextStep(late, all)).toMatchObject({ kind: 'review', items: [{ id: 'm' }] });
    const dropped = plan('m12', 'month', '2026-12', {
      review: { outcome: 'dropped', percent: 0, note: '', carriedTo: null, at: 1 },
    });
    expect(nextStep(now, [...all, dropped])).toEqual({
      kind: 'plan',
      level: 'month',
      period: '2026-12',
    });
  });
});

describe('plan a period', () => {
  const now = periodsOfYmd(2026, 11, 16);
  it('offers this and next quarter, month and week', () => {
    const opts = periodOptions(now, [plan('m', 'month', '2026-11')]);
    expect(opts.map((o) => `${o.period}:${o.empty}`)).toEqual([
      '2026-Q4:true',
      '2027-Q1:true',
      '2026-11:false',
      '2026-12:true',
      '2026-W47:true',
      '2026-W48:true',
    ]);
  });
  it('finds parents and suggestions', () => {
    const q = plan('q', 'quarter', '2026-Q4', {
      keyResults: [
        {
          id: 'k1',
          title: '知識庫 50 份',
          start: 0,
          target: 50,
          current: 12,
          unit: '份',
          manual: true,
        },
        { id: 'k2', title: '完成的 KR', start: 0, target: 1, current: 1, unit: '', manual: true },
      ],
      krProgress: { k1: 24, k2: 100 },
    });
    const prev = plan('m11', 'month', '2026-11', { parentId: 'q', progress: 60 });
    const list = [q, prev, plan('y', 'year', '2026')];
    expect(parentChoices(list, 'month', '2026-12').map((p) => p.id)).toEqual(['q']);
    expect(titleSuggestions(list, q, 'month', '2026-12')).toEqual([
      { kind: 'kr', title: '知識庫 50 份', ref: 'q/k1', note: '24%' },
      { kind: 'carry', title: 'm11', ref: 'm11', note: '60%' },
    ]);
  });
  it('builds the input from the done rule', () => {
    const base = {
      level: 'month' as const,
      period: '2026-12',
      title: ' T ',
      parent: null,
      krRef: 'q/k1',
      target: 30,
      unit: '份',
      visibility: { kind: 'org' as const },
    };
    expect(newPlanInput({ ...base, rule: 'tasks' })).toMatchObject({
      title: 'T',
      krRef: 'q/k1',
      progressOverride: null,
      keyResults: [],
    });
    expect(newPlanInput({ ...base, rule: 'self' }).progressOverride).toBe(0);
    expect(newPlanInput({ ...base, rule: 'number' }).keyResults[0]).toMatchObject({
      target: 30,
      unit: '份',
      manual: true,
    });
  });
});

describe('breakdown', () => {
  it('sums the working hours of a week', () => {
    expect(weekCapacity('2026-W46', null)).toBe(5 * 480);
    expect(weekCapacity('2026-W46', { days: [1, 2, 3], start: '09:00', end: '13:00' })).toBe(
      3 * 240,
    );
  });
  it('suggests tasks due in each week, then key results', () => {
    const m = plan('m', 'month', '2026-12', {
      keyResults: [],
    });
    const q = plan('q', 'quarter', '2026-Q4', {
      keyResults: [
        { id: 'k', title: 'KR', start: 0, target: 1, current: 0, unit: '', manual: false },
      ],
    });
    const due = (id: string, day: number) =>
      ({
        id,
        title: id,
        status: 'todo',
        assignee: 'me',
        dueAt: Date.UTC(2026, 11, day, 4),
      }) as Task;
    const rows = suggestChildren(
      m,
      [m],
      [due('t1', 2), due('t2', 9)],
      'me',
      '2026-11-16',
      'Asia/Taipei',
    );
    expect(rows.map((r) => r.slot.period)).toEqual([
      '2026-W49',
      '2026-W50',
      '2026-W51',
      '2026-W52',
      '2026-W53',
    ]);
    expect(rows[0]).toMatchObject({ title: 't1', on: true, tasks: ['t1'] });
    expect(rows[2]).toMatchObject({ title: '', on: false });
    expect(rows[4]!.on).toBe(false);
    const qRows = suggestChildren(q, [q], [], 'me', '2026-11-16', 'Asia/Taipei');
    expect(qRows.map((r) => `${r.title}:${r.on}`)).toEqual(['KR:false', 'KR:true', 'KR:true']);
  });
});

describe('review and carry', () => {
  it('writes the review and carries to the next period', () => {
    const m = plan('m', 'month', '2026-11', { parentId: 'q', krRef: 'q/k' });
    const c = carryInput(m);
    expect(c).toMatchObject({ period: '2026-12', parentId: 'q', krRef: 'q/k', review: null });
    const r = withReview(c, 'partial', 60.4, ' 晚一週 ', 'n');
    expect(r).toMatchObject({
      done: true,
      progressOverride: 60,
      review: { outcome: 'partial', percent: 60, note: '晚一週', carriedTo: 'n' },
    });
    const q = withReview({ ...c, level: 'quarter', period: '2026-Q4' }, 'achieved', 100, '');
    expect(q.done).toBe(false);
  });
});
