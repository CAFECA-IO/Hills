import { describe, expect, it } from 'vitest';
import type { Direction, PlanView, TeamGoal } from './api';
import {
  chain,
  childSlots,
  emptySlots,
  nextPrompt,
  openCount,
  remainingQuarters,
  remindMonth,
  similarity,
  slotRange,
  suggest,
} from './goals-guided-utils';
import { periodsOfYmd } from './goals-utils';

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

describe('similarity / suggest', () => {
  it('中文標題以字元 bigram 比較', () => {
    expect(similarity('M2 手機版與全員導入', '手機版做到全員都在用')).toBeGreaterThanOrEqual(0.3);
    expect(similarity('技術債減半', '手機版做到全員都在用')).toBe(0);
    expect(similarity('同一句', '同一句')).toBe(1);
    expect(similarity('', 'a')).toBe(0);
  });

  it('只建議達門檻的最相近選項', () => {
    const opts = [
      { id: 'a', title: 'M2 手機版與全員導入' },
      { id: 'b', title: '技術債減半' },
    ];
    expect(suggest('手機版全員導入', opts)).toBe('a');
    expect(suggest('完成 ISO 認證', opts)).toBeNull();
  });
});

describe('childSlots', () => {
  it('年 → 4 季、季 → 3 個月', () => {
    expect(childSlots('year', '2027').map((s) => s.period)).toEqual([
      '2027-Q1',
      '2027-Q2',
      '2027-Q3',
      '2027-Q4',
    ]);
    expect(childSlots('quarter', '2026-Q4').map((s) => s.period)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(childSlots('week', '2026-W46')).toEqual([]);
  });

  it('月 → 週四落在該月的 ISO 週', () => {
    // 2026-11：11/1 是週日（W44 的週四是 10/29，屬 10 月），11/30 週一（W49 週四 12/3 屬 12 月）
    expect(childSlots('month', '2026-11').map((s) => s.period)).toEqual([
      '2026-W45',
      '2026-W46',
      '2026-W47',
      '2026-W48',
    ]);
    // 2027-01：1/1 週五屬 2026-W53
    expect(childSlots('month', '2027-01').map((s) => s.period)).toEqual([
      '2027-W01',
      '2027-W02',
      '2027-W03',
      '2027-W04',
    ]);
  });

  it('期間說明', () => {
    expect(slotRange({ level: 'quarter', period: '2027-Q2' })).toEqual({ from: '4', to: '6' });
    expect(slotRange({ level: 'week', period: '2026-W46' })).toEqual({ from: '11/9', to: '11/15' });
    expect(slotRange({ level: 'month', period: '2026-11' })).toEqual({ from: '11', to: '11' });
  });
});

describe('nextPrompt', () => {
  const nov9 = periodsOfYmd(2026, 11, 9);

  const y26 = plan('y26', 'year', '2026');

  it('今年沒有年目標 → 先規劃今年', () => {
    expect(nextPrompt(nov9, [])).toEqual({ kind: 'planYear', year: '2026' });
    expect(nextPrompt(periodsOfYmd(2026, 3, 2), [])).toEqual({ kind: 'planYear', year: '2026' });
  });

  it('11 月起明年沒有年目標 → 規劃明年', () => {
    expect(nextPrompt(nov9, [y26])).toEqual({ kind: 'planYear', year: '2027' });
    expect(nextPrompt(periodsOfYmd(2026, 10, 30), [y26])).toBeNull();
  });

  it('依序：這個月 → 這一週 → 下一季', () => {
    const y27 = plan('y27', 'year', '2027');
    const q = plan('q', 'quarter', '2026-Q4');
    expect(nextPrompt(nov9, [y26, y27, q])).toEqual({ kind: 'breakdown', parent: q });
    const m = plan('m', 'month', '2026-11');
    expect(nextPrompt(nov9, [y26, y27, q, m])).toEqual({ kind: 'breakdown', parent: m });
    const w = plan('w', 'week', '2026-W46');
    expect(nextPrompt(nov9, [y26, y27, q, m, w])).toBeNull();
    // 12/20：距 2027-Q1 不到 14 天，2027 年目標存在但 Q1 空著
    const dec20 = periodsOfYmd(2026, 12, 20);
    const all = [y26, y27, q, plan('m12', 'month', '2026-12'), plan('w51', 'week', dec20.week)];
    expect(nextPrompt(dec20, all)).toEqual({ kind: 'breakdown', parent: y27 });
    expect(nextPrompt(dec20, [...all, plan('q1', 'quarter', '2027-Q1')])).toBeNull();
  });

  it('只看我的目標', () => {
    expect(nextPrompt(nov9, [y26, plan('y27', 'year', '2027', { mine: false })])).toEqual({
      kind: 'planYear',
      year: '2027',
    });
  });
});

describe('chain', () => {
  const now = periodsOfYmd(2026, 11, 9);
  const dir: Direction = {
    id: 'd',
    year: '2026',
    title: '公司方向',
    keyResults: [],
    createdAt: 0,
    updatedAt: 0,
    progress: 58,
  };
  const goal: TeamGoal = {
    id: 'g',
    team: 't',
    year: '2026',
    title: '小組目標',
    directionId: 'd',
    keyResults: [],
    criteria: [],
    createdAt: 0,
    updatedAt: 0,
    progress: 62,
  };

  it('優先取上一層的子目標，並在最上面加上對齊的方向', () => {
    const plans = [
      plan('y', 'year', '2026', { alignedGoalId: 'g', progress: 58 }),
      plan('q-other', 'quarter', '2026-Q4'),
      plan('q', 'quarter', '2026-Q4', { parentId: 'y' }),
      plan('m', 'month', '2026-11', { parentId: 'q' }),
      plan('w', 'week', '2026-W46', { parentId: 'm' }),
      plan('w-old', 'week', '2026-W45', { parentId: 'm' }),
    ];
    const rows = chain(now, plans, [dir], [goal]);
    expect(rows.map((r) => r.id)).toEqual(['d', 'g', 'y', 'q', 'm', 'w']);
    expect(rows.find((r) => r.id === 'y')?.forTitle).toBe('小組目標');
    expect(rows.find((r) => r.id === 'q')?.forTitle).toBe('y');
    expect(rows.find((r) => r.id === 'q')?.alternatives).toBe(2);
    // 手動換一個
    expect(chain(now, plans, [dir], [goal], { quarter: 'q-other' }).map((r) => r.id)).toEqual([
      'd',
      'g',
      'y',
      'q-other',
      'm',
      'w',
    ]);
  });

  it('直接對齊公司方向；沒有對齊時沒有方向列', () => {
    const plans = [plan('y', 'year', '2026', { alignedGoalId: 'd' })];
    expect(chain(now, plans, [dir], [goal]).map((r) => r.kind)).toEqual(['direction', 'year']);
    expect(chain(now, [plan('y', 'year', '2026')], [dir], [goal]).map((r) => r.kind)).toEqual([
      'year',
    ]);
    // 對齊的目標已刪除
    expect(
      chain(now, [plan('y', 'year', '2026', { alignedGoalId: 'gone' })], [dir], [goal]).length,
    ).toBe(1);
  });
});

describe('其他', () => {
  it('emptySlots 與 remindMonth', () => {
    const slots = childSlots('year', '2027');
    const plans = [plan('q1', 'quarter', '2027-Q1', { parentId: 'y' })];
    expect(emptySlots(slots, plans, 'y').map((s) => s.period)).toEqual([
      '2027-Q2',
      '2027-Q3',
      '2027-Q4',
    ]);
    expect(remindMonth('2027-Q4')).toBe(9);
    expect(remindMonth('2027-Q1')).toBe(12);
  });
});

describe('指派與規劃今年', () => {
  it('openCount 只算未完成、負責人是他的', () => {
    const list = [
      { assignee: 'a', status: 'todo' },
      { assignee: 'a', status: 'done' },
      { assignee: 'a', status: 'doing' },
      { assignee: 'b', status: 'todo' },
    ];
    expect(openCount(list, 'a')).toBe(2);
    expect(openCount(list, 'c')).toBe(0);
  });

  it('remainingQuarters：今年從本季開始', () => {
    const nov9 = periodsOfYmd(2026, 11, 9);
    expect(remainingQuarters('2026', nov9)).toEqual(['2026-Q4']);
    expect(remainingQuarters('2027', nov9)).toHaveLength(4);
  });
});
