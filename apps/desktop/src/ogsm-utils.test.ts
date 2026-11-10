import { describe, expect, it } from 'vitest';
import type { DayLog, DirectionsView, PlanView, StrategyView, Task, TeamGoal } from './api';
import type { Assessment } from './drift-utils';
import { elapsedOf, hillStateOf, myRole, projectShare } from './ogsm-utils';

const goal = (id: string, team: string): TeamGoal => ({
  id,
  team,
  year: '2026',
  title: id,
  directionId: null,
  keyResults: [],
  criteria: [],
  createdAt: 0,
  updatedAt: 0,
  progress: 40,
});

const strategy = (id: string, team: string, owners: string[]): StrategyView => ({
  id,
  team,
  title: id,
  how: null,
  goalIds: [],
  owners,
  measures: [],
  order: 0,
  createdAt: 0,
  updatedAt: 0,
  progress: 0,
  measureProgress: [],
});

const plan = (
  id: string,
  level: PlanView['level'],
  period: string,
  aligned: string | null,
): PlanView =>
  ({
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
    alignedGoalId: aligned,
    criteria: [],
    helps: [],
    createdAt: 0,
    updatedAt: 0,
    progress: 0,
    krProgress: {},
    mine: true,
  }) as PlanView;

describe('ogsm-utils', () => {
  it('computes elapsed share of a year or range', () => {
    expect(elapsedOf('2026', '2026-01-01')).toBeCloseTo(0.5 / 365, 3);
    expect(elapsedOf('2026', '2026-07-02')).toBeCloseTo(0.5, 1);
    expect(elapsedOf('2026–2027', '2026-12-31')).toBeCloseTo(0.5, 2);
    expect(elapsedOf('2026-2027', '2025-06-01')).toBe(0);
    expect(elapsedOf('下半年', '2026-07-01')).toBeNull();
  });

  it('works out my role from OGSM, goals and tasks', () => {
    const view: DirectionsView = {
      directions: [],
      teamGoals: [goal('tg1', 'eng'), goal('tg2', 'ops')],
      purpose: null,
      teamPurposes: [
        {
          title: 'eng',
          why: '',
          period: '',
          goalIds: [],
          updatedAt: 0,
          updatedBy: '',
          team: 'eng',
        },
      ],
      strategies: [
        strategy('s1', 'eng', ['me']),
        strategy('s2', 'eng', []),
        strategy('s3', 'ops', ['me']),
      ],
    };
    const teams = [
      { id: 'eng', name: '工程', members: ['me'], leads: [] },
      { id: 'ops', name: '營運', members: ['x'], leads: [] },
    ];
    const plans = [
      plan('y', 'year', '2026', 'tg1'),
      plan('q', 'quarter', '2026-Q4', null),
      plan('other', 'quarter', '2026-Q4', 'tg2'),
    ];
    const tasks = [
      { id: 't1', status: 'todo', assignee: 'me', planItemId: 'w', teamGoalId: null },
      { id: 't2', status: 'todo', assignee: 'me', planItemId: null, teamGoalId: 'tg1' },
      { id: 't3', status: 'done', assignee: 'me', planItemId: 'w', teamGoalId: null },
    ] as Task[];
    const r = myRole(view, teams, plans, tasks, 'me', '2026', new Set(['w']));
    expect(r.teams.map((x) => x.id)).toEqual(['eng']);
    expect(r.strategies.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(r.owned.map((s) => s.id)).toEqual(['s1']);
    expect(r.purposes).toHaveLength(1);
    // tg2 屬於別的小組，不算對齊我的團隊
    expect(r.aligned.map((p) => p.id)).toEqual(['y']);
    expect(r.myGoals).toBe(3);
    expect(r.weekTasks).toBe(2);
  });

  it('shares time spent on projects this week', () => {
    const days: DayLog[] = [
      {
        date: '2026-11-09',
        entries: [
          { ref: { kind: 'meeting' }, project: null, minutes: 60, source: 'auto' },
          { ref: { kind: 'other', title: 'x' }, project: 'tg1', minutes: 180, source: 'auto' },
        ],
        updatedAt: 0,
      },
      {
        date: '2026-11-01',
        entries: [{ ref: { kind: 'meeting' }, project: null, minutes: 600, source: 'auto' }],
        updatedAt: 0,
      },
    ];
    expect(projectShare(days, ['2026-11-09', '2026-11-10'])).toBe(75);
    expect(projectShare([], ['2026-11-09'])).toBeNull();
  });

  it('maps the four checks to hill states', () => {
    const base = {
      state: 'ok',
      angle: 0,
      share: null,
      progress: null,
      unaligned: false,
      elsewhere: false,
      behind: false,
      stale: false,
      idleDays: 0,
      week: null,
    } as Assessment;
    expect(hillStateOf(base)).toBe('onTrack');
    expect(hillStateOf({ ...base, state: 'warn', behind: true })).toBe('slow');
    expect(hillStateOf({ ...base, state: 'warn', elsewhere: true })).toBe('veered');
    expect(hillStateOf({ ...base, state: 'stale' })).toBe('stopped');
    expect(hillStateOf({ ...base, state: 'unknown' })).toBe('unknown');
  });
});
