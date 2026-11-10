import { describe, expect, it } from 'vitest';
import type { Task, TaskLog, TeamView } from './api';
import {
  canAnswer,
  canAsk,
  canClose,
  canReopen,
  canReport,
  closeIsPrimary,
  lastClose,
  latestPercent,
} from './task-utils';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't',
  team: 'g',
  title: 't',
  assignee: 'me',
  status: 'todo',
  dueAt: 1,
  doneAt: null,
  steps: [],
  planItemId: null,
  createdBy: 'boss',
  createdAt: 0,
  updatedAt: 0,
  assignedBy: 'boss',
  assignedAt: 0,
  teamGoalId: null,
  ack: null,
  pendingAck: false,
  brief: null,
  acceptance: [],
  ...over,
});
const log = (kind: TaskLog['kind'], percent: number | null = null): TaskLog => ({
  id: kind,
  author: 'me',
  kind,
  text: '',
  percent,
  refs: [],
  at: 0,
});
const teams: TeamView[] = [
  { id: 'g', name: 'G', members: ['me', 'boss', 'lead'], leads: ['lead'] },
];

describe('task close permissions (D53)', () => {
  it('an overdue task without steps can be closed by its assignee', () => {
    expect(canClose(task(), 'me')).toBe(true);
    expect(closeIsPrimary(task(), 'me')).toBe(true);
    expect(canClose(task(), 'boss')).toBe(false);
    expect(canClose(task({ status: 'done' }), 'me')).toBe(false);
  });

  it('open steps keep close secondary', () => {
    const t = task({
      steps: [{ id: 's', title: 's', assignee: null, done: false, doneAt: null }],
    });
    expect(canClose(t, 'me')).toBe(true);
    expect(closeIsPrimary(t, 'me')).toBe(false);
  });

  it('private tasks: always mine, no questions or reopen', () => {
    const p = task({ team: 'private', assignee: 'me', status: 'done' });
    expect(canReport(p, 'me')).toBe(true);
    expect(canAsk(p, 'me')).toBe(false);
    expect(canAnswer(p)).toBe(false);
    expect(canReopen(p, 'me', teams)).toBe(false);
  });

  it('reopen by assigner, assignee or team lead', () => {
    const d = task({ status: 'done' });
    expect(canReopen(d, 'boss', teams)).toBe(true);
    expect(canReopen(d, 'me', teams)).toBe(true);
    expect(canReopen(d, 'lead', teams)).toBe(true);
    expect(canReopen(d, 'other', teams)).toBe(false);
    expect(canReopen(task(), 'boss', teams)).toBe(false);
  });

  it('log helpers', () => {
    expect(lastClose([log('progress'), log('close')])?.kind).toBe('close');
    expect(lastClose([log('close'), log('reopen')])).toBeNull();
    expect(latestPercent([log('progress', 30), log('question'), log('progress', 60)])).toBe(60);
    expect(latestPercent([log('start')])).toBeNull();
  });
});
