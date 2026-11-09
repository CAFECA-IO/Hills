import { describe, expect, it } from 'vitest';
import type { DirectionWeek, PlanView, Task, TaskStep } from './api';
import {
  assess,
  chainAligned,
  computeSummary,
  DEFAULT_RULES,
  flat,
  layoutPins,
  meanAngle,
  quarterElapsed,
  sameSummary,
  toScreen,
} from './drift-utils';
import { periodsOfYmd } from './goals-utils';

const TZ = 'Asia/Taipei';
// 2026-11-11（週三）12:00 台北
const NOW = Date.UTC(2026, 10, 11, 4);
const DAY = 86_400_000;

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

const step = (
  id: string,
  done: boolean,
  doneAt: number | null,
  assignee: string | null = null,
): TaskStep => ({
  id,
  title: id,
  assignee,
  done,
  doneAt,
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  team: 'g',
  title: id,
  assignee: 'me',
  status: 'todo',
  dueAt: null,
  doneAt: null,
  steps: [],
  planItemId: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('computeSummary', () => {
  const plans = [
    plan('y', 'year', '2026', { alignedGoalId: 'g1' }),
    plan('q', 'quarter', '2026-Q4', { parentId: 'y', progress: 62, updatedAt: NOW - 3 * DAY }),
    plan('q-loose', 'quarter', '2026-Q4', { progress: 10 }),
    plan('q-priv', 'quarter', '2026-Q4', { visibility: { kind: 'private' }, progress: 90 }),
    plan('m', 'month', '2026-11', { parentId: 'q' }),
    plan('w', 'week', '2026-W46', { parentId: 'm' }),
    plan('w-loose', 'week', '2026-W46'),
  ];

  it('本週完成的步驟與任務；連到對齊鏈的算為了團隊', () => {
    const tasks = [
      // 兩步都在本週由我完成，連到對齊的週目標
      task('a', {
        planItemId: 'w',
        status: 'done',
        steps: [step('a1', true, NOW - DAY), step('a2', true, NOW - 2 * DAY)],
      }),
      // 上週完成的不算
      task('b', { planItemId: 'w', status: 'done', steps: [step('b1', true, NOW - 8 * DAY)] }),
      // 別人負責的步驟不算（步驟負責人優先於任務負責人）
      task('c', {
        planItemId: 'w',
        assignee: 'other',
        steps: [step('c1', true, NOW - DAY, 'other'), step('c2', true, NOW - DAY, 'me')],
      }),
      // 沒有步驟、本週完成、沒連到對齊的週目標
      task('d', { planItemId: 'w-loose', status: 'done', doneAt: NOW - DAY }),
      // 私人任務也算進分母
      task('e', { team: 'private', status: 'done', doneAt: NOW - DAY }),
      // 未完成、本週到期
      task('f', { dueAt: NOW + DAY }),
      task('g', { dueAt: NOW + 10 * DAY }),
    ];
    const s = computeSummary('me', plans, tasks, TZ, NOW);
    expect(s.week).toBe('2026-W46');
    expect(s.units).toBe(5);
    expect(s.alignedUnits).toBe(3);
    expect(s.openTasks).toBe(2);
    expect(s.dueThisWeek).toBe(1);
    expect(s.goals.map((g) => [g.id, g.alignedGoalId])).toEqual([
      ['q', 'g1'],
      ['q-loose', null],
    ]);
    expect(s.privateGoals).toBe(1);
    // 只算已對齊的季目標
    expect(s.quarterProgress).toBe(62);
    expect(s.lastActivity).toBe(NOW - DAY);
  });

  it('沒有已對齊的季目標時取全部平均；沒有季目標時為 null', () => {
    const loose = [
      plan('q1', 'quarter', '2026-Q4', { progress: 20 }),
      plan('q2', 'quarter', '2026-Q4', { progress: 40 }),
    ];
    expect(computeSummary('me', loose, [], TZ, NOW).quarterProgress).toBe(30);
    expect(computeSummary('me', [], [], TZ, NOW).quarterProgress).toBeNull();
  });

  it('chainAligned 防止循環', () => {
    const a = plan('a', 'week', '2026-W46', { parentId: 'b' });
    const b = plan('b', 'month', '2026-11', { parentId: 'a' });
    expect(
      chainAligned(
        'a',
        new Map([
          ['a', a],
          ['b', b],
        ]),
      ),
    ).toBe(false);
  });

  it('sameSummary 不比 updatedAt', () => {
    const s = computeSummary('me', plans, [], TZ, NOW);
    expect(sameSummary(s, { ...s, updatedAt: 5 } as DirectionWeek)).toBe(true);
    expect(sameSummary(s, { ...s, units: 1 })).toBe(false);
    expect(sameSummary(s, null)).toBe(false);
  });
});

describe('assess', () => {
  const p = periodsOfYmd(2026, 11, 11);
  const week = (extra: Partial<DirectionWeek> = {}): DirectionWeek => ({
    week: '2026-W46',
    units: 5,
    alignedUnits: 1,
    quarterProgress: 50,
    goals: [{ id: 'q', title: 'q', progress: 50, alignedGoalId: null }],
    privateGoals: 0,
    lastActivity: NOW,
    openTasks: 0,
    dueThisWeek: 0,
    updatedAt: NOW,
    ...extra,
  });

  it('本季經過比例', () => {
    expect(quarterElapsed(p)).toBeGreaterThan(0.44);
    expect(quarterElapsed(p)).toBeLessThan(0.46);
    expect(quarterElapsed(periodsOfYmd(2026, 10, 1))).toBeLessThan(0.01);
  });

  it('小華：沒對齊＋時間花在別的事', () => {
    const a = assess([week()], DEFAULT_RULES, p, NOW);
    expect(a.state).toBe('warn');
    expect(a.unaligned && a.elsewhere).toBe(true);
    expect(a.behind).toBe(false);
    expect(a.share).toBe(20);
    expect(a.angle).toBe(72);
  });

  it('阿哲：落後＋太久沒更新', () => {
    const a = assess(
      [
        week({
          week: '2026-W44',
          quarterProgress: 8,
          lastActivity: NOW - 16 * DAY,
          goals: [{ id: 'q', title: 'q', progress: 8, alignedGoalId: 'g' }],
        }),
      ],
      DEFAULT_RULES,
      p,
      NOW,
    );
    expect(a.state).toBe('stale');
    expect(a.behind).toBe(true);
    // 本週沒有摘要 → 不判定時間
    expect(a.share).toBeNull();
    expect(a.elsewhere).toBe(false);
    expect(a.angle).toBe(0);
    expect(a.idleDays).toBe(16);
  });

  it('在路上；有私人目標時不判定沒對齊；沒有資料', () => {
    const ok = week({
      alignedUnits: 4,
      goals: [{ id: 'q', title: 'q', progress: 62, alignedGoalId: 'g' }],
      quarterProgress: 62,
    });
    expect(assess([ok], DEFAULT_RULES, p, NOW).state).toBe('ok');
    expect(
      assess([week({ goals: [], privateGoals: 1, alignedUnits: 5 })], DEFAULT_RULES, p, NOW)
        .unaligned,
    ).toBe(false);
    expect(assess([], DEFAULT_RULES, p, NOW).state).toBe('unknown');
    // 門檻
    expect(
      assess(
        [week({ alignedUnits: 3, goals: ok.goals })],
        { ...DEFAULT_RULES, minAlignedShare: 70 },
        p,
        NOW,
      ).elsewhere,
    ).toBe(true);
  });
});

describe('羅盤幾何', () => {
  it('平面與畫面座標', () => {
    const [x, y] = flat(0, 100, 1);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-100);
    const [sx, sy] = toScreen({ cx: 10, cy: 200, rot: 0, squash: 0.5 }, 0, -100);
    expect(sx).toBeCloseTo(10);
    expect(sy).toBeCloseTo(150);
  });

  it('人像重疊時推開', () => {
    const pins = layoutPins(
      [
        { key: 'a', x: 100, y: 100 },
        { key: 'b', x: 105, y: 102 },
        { key: 'c', x: 300, y: 100 },
      ],
      18,
      50,
      62,
    );
    const [a, b, c] = pins;
    expect(Math.abs(a!.ax - b!.ax)).toBeGreaterThanOrEqual(49);
    expect(c!.ax).toBe(300);
    expect(a!.x).toBe(100);
  });

  it('平均方向', () => {
    expect(meanAngle([])).toBeNull();
    expect(
      meanAngle([
        { angle: 20, side: 1 },
        { angle: 20, side: -1 },
      ]),
    ).toBeCloseTo(0);
    expect(meanAngle([{ angle: 30, side: 1 }])).toBeCloseTo(30);
  });
});

describe('第 4 批', () => {
  const w = (week: string, units: number, aligned: number, progress = 50): DirectionWeek => ({
    week,
    units,
    alignedUnits: aligned,
    quarterProgress: progress,
    goals: [],
    privateGoals: 0,
    lastActivity: NOW,
    openTasks: 0,
    dueThisWeek: 0,
    updatedAt: NOW,
  });

  it('四週軌跡與趨勢', async () => {
    const { trailOf, trendOf, weekAngle } = await import('./drift-utils');
    const weeks = [
      w('2026-W46', 5, 1),
      w('2026-W45', 3, 1),
      w('2026-W44', 0, 0),
      w('2026-W43', 6, 5),
      w('2026-W42', 1, 1),
    ];
    expect(weekAngle(weeks[0]!)).toBe(72);
    const trail = trailOf(weeks);
    // W43（15°）→ W45（60°）；W44 沒有完成的事略過；只取最近 4 週
    expect(trail.map((x) => Math.round(x.angle))).toEqual([15, 60]);
    expect(trendOf(trail, 72)).toEqual({ kind: 'away', path: [15, 60, 72] });
    expect(trendOf([{ angle: 36 }], 18)?.kind).toBe('back');
    expect(trendOf([], 18)).toBeNull();
  });

  it('週一方向時刻：列出的任務與預測角度', async () => {
    const { unlinkedThisWeek, predictAngle } = await import('./drift-utils');
    const tasks = [
      task('a'),
      task('b', { dueAt: NOW + DAY }),
      task('c', { dueAt: NOW + 10 * DAY }),
      task('d', { planItemId: 'w' }),
      task('e', { status: 'done' }),
      task('f', { assignee: 'other' }),
    ];
    const listed = unlinkedThisWeek('me', tasks, '2026-W46', TZ);
    expect(listed.map((x) => x.id)).toEqual(['a', 'b']);
    const plans = [
      plan('y', 'year', '2026', { alignedGoalId: 'g' }),
      plan('w', 'week', '2026-W46', { parentId: 'y' }),
    ];
    // 本週 5 件、1 件對齊；a 連到對齊的週目標、b 不連 → (1 + 1) / (5 + 2)
    expect(predictAngle(w('2026-W46', 5, 1), listed, { a: 'w', b: '' }, plans)).toBeCloseTo(
      90 * (1 - 2 / 7),
    );
    expect(predictAngle(null, [], {}, plans)).toBeNull();
  });

  it('週一方向時刻：上週與四週前比較', async () => {
    const { pastTrail } = await import('./drift-utils');
    const weeks = [
      w('2026-W46', 2, 2),
      w('2026-W45', 5, 4),
      w('2026-W44', 0, 0),
      w('2026-W43', 4, 1),
    ];
    const r = pastTrail(weeks, '2026-W46');
    // 不含本週；W44 沒有完成的事略過
    expect(r.points.map((x) => Math.round(x.angle))).toEqual([68, 18]);
    expect(r.change).toBe('tighter');
    expect(pastTrail([w('2026-W45', 1, 1)], '2026-W46').change).toBeNull();
    expect(pastTrail(undefined, '2026-W46').points).toEqual([]);
  });
});
