import { describe, expect, it } from 'vitest';
import type { PlanView, Report, ScrumReport, Task } from './api';
import {
  daysOf,
  generate,
  mergeTeam,
  mondayOf,
  nextWorkday,
  periodOf,
  shiftPeriod,
  toMarkdown,
  type ReportLabels,
} from './reports-utils';

const L: ReportLabels = {
  done: '完成',
  doing: '進行中',
  blockers: '阻礙',
  none: '無',
  weekDone: '本週完成的目標',
  attendancePending: '（待假勤）',
  sections: {
    progress: '完成 / 進行中 / 阻礙',
    okr: 'OKR 進度',
    attendance: '工時與出勤',
    next: '下期計劃',
  },
};
const TZ = 'Asia/Taipei';
const at = (date: string, h = 12) => Date.parse(`${date}T${String(h - 8).padStart(2, '0')}:00:00Z`);

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
  createdAt: 0,
  updatedAt: 0,
  progress: 0,
  krProgress: {},
  mine: true,
  ...extra,
});

describe('periods', () => {
  it('maps dates to periods and back', () => {
    expect(periodOf('weekly', '2026-11-09')).toBe('2026-W46');
    expect(periodOf('weekly', '2027-01-01')).toBe('2026-W53');
    expect(mondayOf('2026-W46')).toBe('2026-11-09');
    expect(daysOf('weekly', '2026-W46')).toHaveLength(7);
    expect(daysOf('weekly', '2026-W46')[6]).toBe('2026-11-15');
    expect(shiftPeriod('weekly', '2026-W53', 1)).toBe('2027-W01');
    expect(shiftPeriod('daily', '2026-11-30', 1)).toBe('2026-12-01');
    expect(nextWorkday('2026-11-13')).toBe('2026-11-16');
  });
});

describe('generate', () => {
  const scrum: ScrumReport[] = [
    {
      member: 'me',
      date: '2026-11-10',
      done: [{ kind: 'text', title: '寫測試' }],
      today: [
        { kind: 'text', title: '壓力測試' },
        { kind: 'text', title: '寫測試' },
      ],
      blockers: [{ text: '需要測試機', notified: [] }],
      submittedAt: 0,
      updatedAt: 0,
    },
    {
      member: 'x',
      date: '2026-11-10',
      done: [{ kind: 'text', title: '別人' }],
      today: [],
      blockers: [],
      submittedAt: 0,
      updatedAt: 0,
    },
  ];
  const tasks = [
    task('A', { status: 'done', updatedAt: at('2026-11-11') }),
    task('B', { status: 'doing' }),
    task('C', { dueAt: at('2026-11-17') }),
    task('D', { status: 'done', updatedAt: at('2026-11-02') }),
    task('T', { dueAt: at('2026-11-11') }),
  ];
  const plans = [
    plan('Q', 'quarter', '2026-Q4', {
      progress: 62.4,
      keyResults: [
        { id: 'k', title: '功能', start: 0, target: 28, current: 18, unit: '項', manual: true },
      ],
      krProgress: { k: 64.3 },
    }),
    plan('W', 'week', '2026-W46', { done: true }),
    plan('N', 'week', '2026-W47'),
  ];
  it('builds the weekly sections', () => {
    const s = generate({
      kind: 'weekly',
      period: '2026-W46',
      me: 'me',
      tz: TZ,
      scrum,
      tasks,
      plans,
      labels: L,
    });
    expect(s.progress).toContain('- 寫測試');
    expect(s.progress).toContain('- A');
    expect(s.progress).not.toContain('- D');
    expect(s.progress).not.toContain('別人');
    expect(s.progress).toContain('**進行中**\n- B');
    expect(s.progress).toContain('**阻礙**\n- 需要測試機');
    expect(s.okr).toContain('- Q — 62%');
    expect(s.okr).toContain('  - 功能：18 / 28 項（64%）');
    expect(s.okr).toContain('**本週完成的目標**\n- W');
    expect(s.attendance).toBe('（待假勤）');
    expect(s.next).toBe('- N\n- C');
  });
  it('builds the daily next plan from tasks due on the next workday and unfinished scrum items', () => {
    const s = generate({
      kind: 'daily',
      period: '2026-11-10',
      me: 'me',
      tz: TZ,
      scrum,
      tasks,
      plans,
      labels: L,
    });
    expect(s.next).toBe('- T\n- 壓力測試');
  });
  it('uses "none" when there is nothing', () => {
    const s = generate({
      kind: 'daily',
      period: '2026-11-01',
      me: 'me',
      tz: TZ,
      scrum: [],
      tasks: [],
      plans: [],
      labels: L,
    });
    expect(s.okr).toBe('- 無');
    expect(s.next).toBe('- 無');
  });
});

describe('markdown and team merge', () => {
  const sections = { progress: '- a', okr: '', attendance: 'x', next: '- b' };
  it('exports markdown with all four headings', () => {
    const md = toMarkdown('週報 2026-W46', sections, L);
    expect(md.startsWith('# 週報 2026-W46')).toBe(true);
    expect(md).toContain('## OKR 進度\n\n- 無');
    expect(md).toContain('## 下期計劃\n\n- b');
  });
  it('merges team reports per section', () => {
    const r = (member: string): Report => ({
      member,
      kind: 'weekly',
      period: '2026-W46',
      sections,
      publishedTo: [],
      generatedAt: 0,
      publishedAt: 0,
      editedAt: null,
    });
    const m = mergeTeam([r('a'), r('b')], (id) => id.toUpperCase(), L);
    expect(m.progress).toBe('**A**\n\n- a\n\n**B**\n\n- a');
    expect(mergeTeam([], (x) => x, L).next).toBe('- 無');
  });
});
