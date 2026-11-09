import { describe, expect, it } from 'vitest';
import type { Task, TeamView } from './api';
import {
  addRows,
  assignedToMe,
  boardColumns,
  inputOf,
  canAssign,
  loadOf,
  loads,
  parseLines,
  rowsToCreate,
  sortByLoad,
} from './assign-utils';

const TZ = 'Asia/Taipei';
// 2026-11-11（三）中午，W46
const NOW = Date.UTC(2026, 10, 11, 4);
const DAY = 86_400_000;
const WEEK = '2026-W46';

const task = (p: Partial<Task>): Task => ({
  id: p.id ?? 't',
  team: 'g',
  title: 'x',
  assignee: null,
  status: 'todo',
  dueAt: null,
  doneAt: null,
  steps: [],
  planItemId: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  assignedBy: null,
  assignedAt: null,
  teamGoalId: null,
  ack: null,
  pendingAck: false,
  ...p,
});

describe('assign-utils', () => {
  it('負荷：未完成、本週到期（含逾期）、偏重', () => {
    const ts = [
      task({ assignee: 'a', dueAt: NOW }),
      task({ assignee: 'a', dueAt: NOW - 10 * DAY }),
      task({ assignee: 'a', dueAt: NOW + 10 * DAY }),
      task({ assignee: 'a', status: 'done', dueAt: NOW }),
      task({ assignee: 'b' }),
    ];
    const l = loads(ts, WEEK, TZ);
    expect(loadOf(l, 'a')).toEqual({ open: 3, dueThisWeek: 2, heavy: false });
    expect(loadOf(l, 'z')).toEqual({ open: 0, dueThisWeek: 0, heavy: false });
    const heavy = loads(
      Array.from({ length: 4 }, () => task({ assignee: 'c', dueAt: NOW })),
      WEEK,
      TZ,
    );
    expect(loadOf(heavy, 'c').heavy).toBe(true);
    const after = addRows(
      l,
      [
        { title: '新', assignee: 'b', dueAt: NOW },
        { title: ' ', assignee: 'b', dueAt: NOW },
      ],
      WEEK,
      TZ,
    );
    expect(loadOf(after, 'b')).toEqual({ open: 2, dueThisWeek: 1, heavy: false });
  });

  it('依負荷排序，輕的在前', () => {
    const l = loads(
      [task({ assignee: 'a', dueAt: NOW }), task({ assignee: 'b' }), task({ assignee: 'b' })],
      WEEK,
      TZ,
    );
    const ms = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    expect(sortByLoad(ms, l).map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('分派板欄位與權限', () => {
    const team: TeamView = { id: 'g', name: 'G', members: ['a', 'b'], leads: ['a'] };
    const cols = boardColumns(
      [
        task({ id: '1', assignee: 'a', dueAt: 5 }),
        task({ id: '2', assignee: null }),
        task({ id: '3', assignee: 'x' }),
        task({ id: '4', assignee: 'b', status: 'done' }),
        task({ id: '5', assignee: 'a', team: 'other' }),
      ],
      team,
    );
    expect(cols.people).toEqual(['a', 'b']);
    expect(cols.unassigned.map((t) => t.id)).toEqual(['2', '3']);
    expect(cols.byMember.a?.map((t) => t.id)).toEqual(['1']);
    expect(cols.byMember.b).toEqual([]);
    expect(canAssign(team, 'a', false)).toBe(true);
    expect(canAssign(team, 'b', false)).toBe(false);
    expect(canAssign(team, 'b', true)).toBe(true);
  });

  it('貼上多行與要建立的列', () => {
    expect(parseLines('- 製程流程圖\n\n2. 設施清冊\n• 可觀測數據  ')).toEqual([
      '製程流程圖',
      '設施清冊',
      '可觀測數據',
    ]);
    expect(
      rowsToCreate([
        { title: ' A ', assignee: null, dueAt: null },
        { title: '', assignee: 'a', dueAt: null },
      ]),
    ).toEqual([{ title: 'A', assignee: null, dueAt: null }]);
  });

  it('新指派給我', () => {
    const ts = [
      task({ id: '1', assignee: 'me', pendingAck: true, assignedAt: 1 }),
      task({ id: '2', assignee: 'me', pendingAck: false }),
      task({ id: '3', assignee: 'me', pendingAck: true, assignedAt: 5 }),
      task({ id: '4', assignee: 'b', pendingAck: true }),
    ];
    expect(assignedToMe(ts, 'me').map((t) => t.id)).toEqual(['3', '1']);
    expect(assignedToMe(ts, null)).toEqual([]);
  });

  it('改派時清掉原負責人的週目標，其他欄位保留', () => {
    const t = task({ assignee: 'a', planItemId: 'w1', teamGoalId: 'g1', dueAt: 9 });
    expect(inputOf(t, { assignee: 'b' })).toMatchObject({
      assignee: 'b',
      planItemId: null,
      teamGoalId: 'g1',
      dueAt: 9,
    });
    expect(inputOf(t, { planItemId: 'w2' }).planItemId).toBe('w2');
    expect(inputOf(t, { assignee: 'a' }).planItemId).toBe('w1');
  });
});
