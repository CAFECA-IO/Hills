import { describe, expect, it } from 'vitest';
import type { MemberView, ScrumReport, Task } from './api';
import {
  addDays,
  clockIn,
  doneSince,
  isWorkday,
  mergeRefs,
  prevWorkday,
  shouldRemind,
  teamStatus,
  todayPlan,
} from './scrum-utils';

const TZ = 'Asia/Taipei';
// 2026-11-09（一）10:00 台北
const MON = Date.UTC(2026, 10, 9, 2);

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  doneAt: null,
  id,
  team: 'g',
  planItemId: null,
  title: id,
  assignee: null,
  status: 'doing',
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
  ...extra,
});

describe('workdays', () => {
  it('skips weekends; Monday looks back to Friday', () => {
    expect(isWorkday('2026-11-09')).toBe(true);
    expect(isWorkday('2026-11-08')).toBe(false);
    expect(prevWorkday('2026-11-09')).toBe('2026-11-06');
    expect(prevWorkday('2026-11-10')).toBe('2026-11-09');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('accepts holiday calendar overrides', () => {
    expect(isWorkday('2026-11-09', ['2026-11-09'])).toBe(false);
    expect(isWorkday('2026-11-08', [], ['2026-11-08'])).toBe(true);
  });
});

describe('prefill', () => {
  const fri = Date.UTC(2026, 10, 6, 6);
  const tasks = [
    task('a', {
      steps: [
        { id: 's1', title: '寫測試', assignee: 'me', done: true, doneAt: fri },
        { id: 's2', title: '別人', assignee: 'x', done: true, doneAt: fri },
      ],
    }),
    task('b', { status: 'done', assignee: 'me', updatedAt: fri }),
    task('c', { status: 'done', assignee: 'me', updatedAt: Date.UTC(2026, 10, 1) }),
    task('d', { dueAt: MON + 3_600_000 }),
    task('e'),
    task('f', { team: 'private', assignee: 'me', status: 'done', updatedAt: fri }),
  ];
  it('collects what I finished since the previous workday', () => {
    const refs = doneSince(tasks, 'me', '2026-11-09', TZ);
    expect(refs.map((r) => r.title)).toEqual(['a：寫測試', 'b', 'f']);
    expect(refs[2]?.kind).toBe('text');
  });
  it('collects focus, and my tasks due today or in progress', () => {
    const list = [
      ...tasks,
      task('g', { assignee: 'me' }),
      task('h', { assignee: 'me', status: 'todo' }),
      task('i', { assignee: 'x', dueAt: MON }),
    ];
    expect(todayPlan(list, 'me', 'e', '2026-11-09', TZ).map((r) => r.title)).toEqual(['e', 'g']);
  });
  it('merges without duplicates', () => {
    const a = [{ kind: 'text' as const, title: 'x' }];
    expect(
      mergeRefs(a, [
        { kind: 'text', title: ' x ' },
        { kind: 'text', title: 'y' },
      ]),
    ).toHaveLength(2);
  });
});

describe('team status and reminders', () => {
  const m = (id: string): MemberView => ({
    id,
    name: id,
    rosterName: id,
    isAdmin: false,
    isMe: false,
    joinedAt: 0,
    presence: null,
    note: '',
    until: null,
    location: 'hidden',
    look: null,
  });
  const report: ScrumReport = {
    member: 'a',
    date: '2026-11-09',
    done: [],
    today: [],
    blockers: [],
    submittedAt: 0,
    updatedAt: 0,
  };
  it('marks submitted, missing and off days', () => {
    expect(teamStatus([m('a'), m('b')], [report], '2026-11-09').map((x) => x.status)).toEqual([
      'submitted',
      'missing',
    ]);
    expect(teamStatus([m('b')], [], '2026-11-08')[0]?.status).toBe('offday');
  });
  it('reminds on workdays after the reminder time in the org time zone', () => {
    expect(clockIn(MON, TZ)).toBe('10:00');
    expect(shouldRemind(MON, TZ, '09:30')).toBe(true);
    expect(shouldRemind(MON, TZ, '17:30')).toBe(false);
    expect(shouldRemind(Date.UTC(2026, 10, 8, 12), TZ, '09:30')).toBe(false);
  });
  it('follows the member work days when given (D57)', () => {
    expect(shouldRemind(MON, TZ, '09:30', [2, 3])).toBe(false);
    expect(shouldRemind(Date.UTC(2026, 10, 8, 12), TZ, '09:30', [7])).toBe(true);
    expect(shouldRemind(MON, TZ, '09:30', [])).toBe(false);
  });
});
