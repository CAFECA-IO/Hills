import { describe, expect, it } from 'vitest';
import type { PlanView, Task, TimerSegment, WorkRef } from './api';
import {
  clock,
  dayStartIn,
  entriesFromSegments,
  hm,
  projectOf,
  round15,
  todayList,
  weekPlanFrom,
  workMinutesOf,
} from './work-utils';

const TZ = 'Asia/Taipei';
/** 台北時間某日某時 */
const at = (date: string, h: number, m = 0) =>
  Date.parse(`${date}T00:00:00Z`) + (h - 8) * 3_600_000 + m * 60_000;

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  doneAt: null,
  id,
  team: 'g',
  planItemId: null,
  title: id,
  assignee: 'me',
  status: 'todo',
  dueAt: null,
  steps: [],
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  assignedBy: null,
  assignedAt: null,
  teamGoalId: null,
  ack: null,
  pendingAck: false,
  brief: null,
  acceptance: [],
  ...extra,
});

const plan = (
  id: string,
  level: PlanView['level'],
  period: string,
  extra: Partial<PlanView> = {},
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
  ...extra,
});

const ref = (id: string): WorkRef => ({ kind: 'task', team: 'g', task: id, step: null, title: id });
const seg = (r: WorkRef, start: number, end: number): TimerSegment => ({
  id: `s${start}`,
  ref: r,
  start,
  end,
  source: 'start',
});

describe('time zones', () => {
  it('finds local midnight', () => {
    expect(dayStartIn('2026-11-10', TZ)).toBe(Date.parse('2026-11-09T16:00:00Z'));
    expect(dayStartIn('2026-11-10', 'UTC')).toBe(Date.parse('2026-11-10T00:00:00Z'));
  });
});

describe('entriesFromSegments', () => {
  const project = (r: WorkRef) => (r.kind === 'task' && r.task === 'a' ? 'tg1' : null);

  it('sums per item, rounds to 15 minutes and fills the rest', () => {
    const d = '2026-11-10';
    const out = entriesFromSegments(
      [
        seg(ref('a'), at(d, 9), at(d, 10, 20)),
        seg(ref('a'), at(d, 14), at(d, 14, 50)),
        seg(ref('b'), at(d, 11), at(d, 11, 5)),
        { ...seg({ kind: 'meeting' }, at(d, 15), at(d, 16)), id: 'm' },
      ],
      d,
      TZ,
      project,
      480,
      '訊息與零碎',
    );
    // a：80 + 50 = 130 → 135；b：5 → 0（略過）；會議 60
    expect(out.map((e) => [e.ref.kind, e.minutes, e.project])).toEqual([
      ['task', 135, 'tg1'],
      ['meeting', 60, null],
      ['other', 285, null],
    ]);
    expect(out.every((e) => e.source === 'auto')).toBe(true);
  });

  it('clips segments to the day and adds nothing on an empty day', () => {
    const d = '2026-11-10';
    const out = entriesFromSegments(
      [seg(ref('a'), at('2026-11-09', 23), at(d, 1))],
      d,
      TZ,
      project,
      0,
      'x',
    );
    expect(out).toEqual([{ ref: ref('a'), project: 'tg1', minutes: 60, source: 'auto' }]);
    expect(entriesFromSegments([], d, TZ, project, 480, 'x')).toEqual([]);
  });
});

describe('workMinutesOf', () => {
  it('subtracts lunch on a full day and is 0 on weekends', () => {
    expect(workMinutesOf('2026-11-10', null)).toBe(480);
    expect(workMinutesOf('2026-11-14', null)).toBe(0);
    expect(workMinutesOf('2026-11-10', { days: [2], start: '09:00', end: '13:00' })).toBe(240);
  });
});

describe('projectOf', () => {
  const plans = [
    plan('q', 'quarter', '2026-Q4', { alignedGoalId: 'tg1' }),
    plan('m', 'month', '2026-11', { parentId: 'q' }),
    plan('w', 'week', '2026-W46', { parentId: 'm' }),
  ];
  const ids = new Set(['tg1', 'tg2']);

  it('walks up from the week goal to the aligned team goal', () => {
    expect(projectOf({ planItemId: 'w', teamGoalId: null }, plans, ids)).toBe('tg1');
  });
  it('falls back to the task source team goal', () => {
    expect(projectOf({ planItemId: null, teamGoalId: 'tg2' }, plans, ids)).toBe('tg2');
    expect(projectOf({ planItemId: null, teamGoalId: 'gone' }, plans, ids)).toBeNull();
  });
});

describe('weekPlanFrom', () => {
  it('takes my open tasks due this week or linked to this week', () => {
    const plans = [plan('w', 'week', '2026-W46')];
    const tasks = [
      task('due', { dueAt: at('2026-11-12', 18), estimate: 120 }),
      task('linked', { planItemId: 'w' }),
      task('next', { dueAt: at('2026-11-17', 18) }),
      task('done', { dueAt: at('2026-11-12', 18), status: 'done' }),
      task('other', { dueAt: at('2026-11-12', 18), assignee: 'x' }),
    ];
    const p = weekPlanFrom(tasks, 'me', '2026-W46', TZ, plans, new Set(), 2400);
    expect(p.tasks.map((x) => [x.ref.kind === 'task' && x.ref.task, x.estimate])).toEqual([
      ['due', 120],
      ['linked', null],
    ]);
    expect(p.capacity).toBe(2400);
  });
});

describe('todayList', () => {
  it('lists overdue, due today, focus, doing and blocked; overdue first', () => {
    const today = '2026-11-10';
    const tasks = [
      task('later', { dueAt: at('2026-11-20', 18) }),
      task('today', { dueAt: at(today, 18) }),
      task('overdue', { dueAt: at('2026-11-08', 18) }),
      task('focus'),
      task('doing', { status: 'doing' }),
      task('mine-step', {
        assignee: 'x',
        status: 'doing',
        steps: [{ id: 's', title: 's', assignee: 'me', done: false, doneAt: null }],
      }),
      task('theirs', { assignee: 'x', status: 'doing' }),
      task('closed', { dueAt: at(today, 9), status: 'done' }),
    ];
    expect(todayList(tasks, 'me', 'focus', today, TZ).map((x) => x.id)).toEqual([
      'overdue',
      'today',
      'focus',
      'doing',
      'mine-step',
    ]);
  });
});

describe('formatting', () => {
  it('formats clocks and minutes', () => {
    expect(clock(3_725_000)).toBe('1:02:05');
    expect(hm(135)).toBe('2:15');
    expect(round15(7)).toBe(0);
    expect(round15(8)).toBe(15);
  });
});
