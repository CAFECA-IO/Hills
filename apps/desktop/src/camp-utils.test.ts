import { describe, expect, it } from 'vitest';
import type { ConvRow, MemberView, MessageView, Task } from './api';
import { firstLine, knockTargets, reportableStep, resolveLinked, timeline } from './camp-utils';

const msg = (
  id: string,
  at: number,
  kind = 'text',
  extra: Partial<MessageView> = {},
): MessageView => ({
  id,
  conv: 'c',
  author: 'a',
  createdAt: at,
  kind,
  body: id,
  mentions: [],
  attachments: null,
  ...extra,
});

const task = (steps: Task['steps']): Task => ({
  doneAt: null,
  id: 't1',
  team: 'g',
  planItemId: null,
  title: '驗收',
  assignee: null,
  status: 'doing',
  dueAt: null,
  steps,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  assignedBy: null,
  assignedAt: null,
  teamGoalId: null,
  ack: null,
  pendingAck: false,
});

const member = (
  id: string,
  presence: MemberView['presence'],
  until: number | null = null,
): MemberView => ({
  id,
  name: id,
  isAdmin: false,
  isMe: id === 'me',
  joinedAt: 0,
  presence,
  note: '',
  until,
  location: 'hidden',
  look: null,
});

const conv = (kind: ConvRow['kind'], members: string[]): ConvRow => ({
  id: 'c',
  kind,
  name: '',
  creator: 'me',
  createdAt: 0,
  members,
  last: null,
  unread: 0,
  task: null,
});

describe('timeline', () => {
  it('merges messages, link rows and derived step rows in time order', () => {
    const t = task([
      { id: 's0', title: '太早', assignee: null, done: true, doneAt: 5 },
      { id: 's1', title: '中間', assignee: null, done: true, doneAt: 15 },
      { id: 's2', title: '之後', assignee: null, done: true, doneAt: 40 },
      { id: 's3', title: '未完成', assignee: null, done: false, doneAt: null },
    ]);
    const items = timeline([msg('m1', 10), msg('l1', 20, 'task'), msg('m2', 30)], t);
    expect(items.map((i) => (i.type === 'step' ? i.step.id : `${i.type}:${i.m.id}`))).toEqual([
      'msg:m1',
      's1',
      'link:l1',
      'msg:m2',
      's2',
    ]);
  });
  it('shows no step rows without messages', () => {
    const t = task([{ id: 's1', title: 'x', assignee: null, done: true, doneAt: 1 }]);
    expect(timeline([], t)).toEqual([]);
  });
});

describe('task helpers', () => {
  it('finds my first unfinished step', () => {
    const t = task([
      { id: 's1', title: 'a', assignee: 'me', done: true, doneAt: 1 },
      { id: 's2', title: 'b', assignee: 'x', done: false, doneAt: null },
      { id: 's3', title: 'c', assignee: 'me', done: false, doneAt: null },
    ]);
    expect(reportableStep(t, 'me')?.id).toBe('s3');
    expect(reportableStep(t, 'y')).toBeNull();
    expect(reportableStep(null, 'me')).toBeNull();
  });
  it('resolves linked task or marks it missing', () => {
    const t = task([]);
    expect(resolveLinked({ team: 'g', id: 't1' }, [t]).task).toBe(t);
    expect(resolveLinked({ team: 'g', id: 'zz' }, [t])).toEqual({ task: null, missing: true });
    expect(resolveLinked(null, [t])).toEqual({ task: null, missing: false });
  });
});

describe('knockTargets', () => {
  const members = [member('me', 'Online'), member('bob', 'Meeting', 100), member('amy', 'Online')];
  it('dm looks at the other member', () => {
    expect(knockTargets(conv('dm', ['me', 'bob']), members, 'me', [], 50).map((m) => m.id)).toEqual(
      ['bob'],
    );
    expect(knockTargets(conv('dm', ['me', 'bob']), members, 'me', [], 200)).toEqual([]);
  });
  it('group looks at mentioned members only', () => {
    const g = conv('group', ['me', 'bob', 'amy']);
    expect(knockTargets(g, members, 'me', [], 50)).toEqual([]);
    expect(knockTargets(g, members, 'me', ['bob', 'amy'], 50).map((m) => m.id)).toEqual(['bob']);
  });
});

describe('firstLine', () => {
  it('takes the first non-empty line without markdown marks', () => {
    expect(firstLine('\n\n## **修正** 通知\n第二行')).toBe('修正 通知');
    expect(firstLine('- `relay` 更新')).toBe('relay 更新');
    expect(firstLine('長'.repeat(120))).toHaveLength(100);
  });
});
