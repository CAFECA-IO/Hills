import { describe, expect, it } from 'vitest';
import type { DayLog, ReportData, WeekPlan } from './api';
import {
  NONTASK,
  OTHER,
  deviationOf,
  hours,
  mergeReports,
  periodDays,
  periodOfDay,
  planOf,
  reportMarkdown,
  shiftKindPeriod,
  summaryOf,
  timeRows,
  toCsv,
  worklogCsv,
  type MdText,
  type SummaryText,
} from './report-utils';

const task = (task: string, title = task) => ({ kind: 'task' as const, team: 'T', task, title });

const worklog: DayLog[] = [
  {
    date: '2026-11-09',
    updatedAt: 0,
    entries: [
      { ref: task('a', 'A'), project: 'g1', minutes: 120, source: 'auto' },
      { ref: task('b', 'B'), project: null, minutes: 30, source: 'auto' },
      { ref: { kind: 'meeting' }, minutes: 45, source: 'auto' },
    ],
  },
  {
    date: '2026-11-10',
    updatedAt: 0,
    entries: [
      { ref: task('c', 'C, "quoted"'), project: 'g2', minutes: 200, source: 'manual' },
      { ref: task('a', 'A'), project: 'g1', minutes: 60, source: 'edited' },
    ],
  },
  {
    date: '2026-11-20',
    updatedAt: 0,
    entries: [{ ref: task('a'), project: 'g1', minutes: 999, source: 'auto' }],
  },
];

describe('periods', () => {
  it('maps a day to each kind', () => {
    expect(periodOfDay('daily', '2026-11-11')).toBe('2026-11-11');
    expect(periodOfDay('weekly', '2026-11-11')).toBe('2026-W46');
    expect(periodOfDay('monthly', '2026-11-11')).toBe('2026-11');
    expect(periodOfDay('quarterly', '2026-11-11')).toBe('2026-Q4');
    expect(periodOfDay('yearly', '2026-11-11')).toBe('2026');
  });
  it('lists days of a period', () => {
    expect(periodDays('weekly', '2026-W46')).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(periodDays('monthly', '2026-02')).toHaveLength(28);
    expect(periodDays('quarterly', '2026-Q1')).toHaveLength(90);
    expect(periodDays('yearly', '2028')).toHaveLength(366);
  });
  it('shifts across boundaries', () => {
    expect(shiftKindPeriod('daily', '2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftKindPeriod('weekly', '2026-W01', -1)).toBe('2025-W52');
    expect(shiftKindPeriod('monthly', '2026-01', -1)).toBe('2025-12');
    expect(shiftKindPeriod('quarterly', '2026-Q4', 1)).toBe('2027-Q1');
    expect(shiftKindPeriod('yearly', '2026', -2)).toBe('2024');
  });
});

describe('timeRows', () => {
  it('sums by project, other and non-task last, ignores out-of-range days', () => {
    const rows = timeRows(worklog, periodDays('weekly', '2026-W46').slice(0, 2));
    expect(rows).toEqual([
      { project: 'g2', minutes: 200 },
      { project: 'g1', minutes: 180 },
      { project: OTHER, minutes: 30 },
      { project: NONTASK, minutes: 45 },
    ]);
  });
});

describe('plan', () => {
  const snapshots: WeekPlan[] = [
    {
      week: '2026-W46',
      capacity: 2400,
      createdAt: 0,
      tasks: [
        { ref: task('a'), estimate: 120, project: 'g1' },
        { ref: task('c'), estimate: 300, project: 'g2' },
      ],
    },
  ];
  it('compares plan with actual and counts done tasks', () => {
    const time = timeRows(worklog, ['2026-11-09', '2026-11-10']);
    const tasks = [
      { id: 'a', status: 'done' },
      { id: 'c', status: 'doing' },
    ] as never;
    const plan = planOf(snapshots, time, tasks, 1);
    expect(plan.tasks).toEqual({ planned: 2, done: 1, carried: 1 });
    expect(plan.minutes).toEqual(
      expect.arrayContaining([
        { project: 'g1', planned: 120, actual: 180 },
        { project: 'g2', planned: 300, actual: 200 },
      ]),
    );
    // (60 + 100) / 420
    expect(deviationOf(plan)).toBe(38);
  });
  it('has no deviation without a plan', () => {
    expect(deviationOf({ minutes: [], tasks: { planned: 0, done: 0, carried: 0 } })).toBeNull();
  });
});

const data = (p: Partial<ReportData> = {}): ReportData => ({
  summary: '',
  summaryEdited: false,
  time: [
    { project: 'g1', minutes: 300 },
    { project: NONTASK, minutes: 60 },
  ],
  projects: [{ project: 'g1', title: 'G1', start: 10, end: 20, mine: 4 }],
  plan: {
    minutes: [{ project: 'g1', planned: 240, actual: 300 }],
    tasks: { planned: 4, done: 3, carried: 1 },
  },
  reasons: [{ kind: 'unplanned', text: 'X', minutes: 30 }],
  doneMd: '- A',
  nextMd: '- B',
  ...p,
});

const tx: SummaryText = {
  empty: 'EMPTY.',
  top: (title, h, share, mine) => `${title} ${h}h ${share}% +${mine}. `,
  rest: (o, u, n) => `rest ${o}/${u}/${n}. `,
  tasks: (d, p) => `${d}/${p}`,
  deviation: (pct) => ` dev ${pct}%`,
  because: (r) => ` because ${r}`,
  reasonName: (k) => k,
  end: '.',
};

describe('summaryOf', () => {
  it('builds the sentence from the data', () => {
    expect(summaryOf(data(), (p) => p.toUpperCase(), tx)).toBe(
      'G1 5h 83% +4. rest 0/0.5/1. 3/4 dev 25% because unplanned.',
    );
  });
  it('says so when there is no time', () => {
    expect(
      summaryOf(
        data({ time: [], plan: { minutes: [], tasks: { planned: 0, done: 0, carried: 0 } } }),
        String,
        tx,
      ),
    ).toBe('EMPTY.');
  });
});

describe('mergeReports', () => {
  it('adds time, plan and progress across reports', () => {
    const m = mergeReports([
      data(),
      data({
        time: [
          { project: 'g1', minutes: 60 },
          { project: OTHER, minutes: 30 },
        ],
        projects: [{ project: 'g1', title: 'G1', start: 20, end: 30, mine: 2 }],
        nextMd: '- C',
      }),
    ]);
    expect(m.time).toEqual([
      { project: 'g1', minutes: 360 },
      { project: OTHER, minutes: 30 },
      { project: NONTASK, minutes: 60 },
    ]);
    expect(m.projects).toEqual([{ project: 'g1', title: 'G1', start: 10, end: 30, mine: 6 }]);
    expect(m.plan.tasks).toEqual({ planned: 8, done: 6, carried: 2 });
    expect(m.doneMd).toBe('- A\n- A');
    expect(m.nextMd).toBe('- C');
  });
});

describe('export', () => {
  const md: MdText = {
    section: (k) => k.toUpperCase(),
    next: 'NEXT',
    project: (p) => p,
    reasonName: (k) => k,
    hoursUnit: 'h',
    deviation: (pct) => `dev ${pct}%`,
    tasks: (d, p, c) => `${d}/${p}/${c}`,
    none: 'none',
  };
  it('renders only the chosen sections', () => {
    const out = reportMarkdown(
      'T',
      'meta',
      data({ summary: 'S' }),
      ['summary', 'time', 'done'],
      md,
    );
    expect(out).toContain('# T');
    expect(out).toContain('## SUMMARY\n\nS');
    expect(out).toContain('- g1：5 h（83%）');
    expect(out).toContain('## NEXT\n\n- B');
    expect(out).not.toContain('## PLAN');
  });
  it('quotes CSV cells that need it', () => {
    expect(toCsv([['a', 'b,c', 'd"e', 1]])).toBe('a,"b,c","d""e",1\r\n');
  });
  it('lists worklog rows in date order', () => {
    const csv = worklogCsv(
      worklog,
      ['2026-11-09', '2026-11-10'],
      ['d', 'i', 'p', 'm', 's'],
      (p) => p,
      (x) => `<${x}>`,
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe('2026-11-09,<meeting>,nontask,45,auto');
    expect(lines[4]).toBe('2026-11-10,"C, ""quoted""",g2,200,manual');
  });
  it('formats hours with one decimal', () => {
    expect(hours(90)).toBe('1.5');
    expect(hours(120)).toBe('2');
    expect(hours(5)).toBe('0.1');
  });
});
