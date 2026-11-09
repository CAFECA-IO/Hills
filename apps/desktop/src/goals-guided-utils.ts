/** 引導式目標的純函式（ui-spec「目標」v0.19，D47；technical-design §16.10、§16.14）。 */
import type { Direction, PlanLevel, PlanView, TeamGoal } from './api';
import { containsPeriod, joinPeriod, periodsOfYmd, weekRange, type Periods } from './goals-utils';

// ── 標題相近度（規劃精靈的「Hills 建議」，第 5 批的群聚） ─────────

function grams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const chars = [...t];
  if (chars.length < 2) return new Set(chars);
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 字元 bigram 的 Dice 相似度（0–1），中英文都適用。 */
export function similarity(a: string, b: string): number {
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return (2 * inter) / (x.size + y.size);
}

/** 規劃精靈建議的相似度門檻（ui-spec「目標」：≥ 0.3）。 */
export const SUGGEST_THRESHOLD = 0.3;

/** 最相近且達門檻的選項 id。 */
export function suggest<T extends { id: string; title: string }>(
  title: string,
  options: T[],
): string | null {
  let best: { id: string; score: number } | null = null;
  for (const o of options) {
    const score = similarity(title, o.title);
    if (score >= SUGGEST_THRESHOLD && (!best || score > best.score)) best = { id: o.id, score };
  }
  return best?.id ?? null;
}

// ── 分到下一層 ─────────────────────────────────────────────

export interface Slot {
  level: PlanLevel;
  period: string;
}

const CHILD: Partial<Record<PlanLevel, PlanLevel>> = {
  year: 'quarter',
  quarter: 'month',
  month: 'week',
};

/** 上層期間之下的每個子期間：年 → 4 季、季 → 3 個月、月 → 週四落在該月的 ISO 週。 */
export function childSlots(level: PlanLevel, period: string): Slot[] {
  const child = CHILD[level];
  if (!child) return [];
  const y = Number(period.slice(0, 4));
  if (child === 'quarter') return [1, 2, 3, 4].map((n) => ({ level: child, period: `${y}-Q${n}` }));
  if (child === 'month') {
    const q = Number(period.split('-Q')[1]);
    return [0, 1, 2].map((i) => ({
      level: child,
      period: joinPeriod('month', y, (q - 1) * 3 + i + 1),
    }));
  }
  // 月 → 週：從當月 1 日所在週開始，列出週四在當月的週
  const m = Number(period.split('-')[1]);
  const out: Slot[] = [];
  for (let d = 1; d <= 31; d += 7) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    const p = periodsOfYmd(y, m, d).week;
    if (!out.some((s) => s.period === p) && containsPeriod(period, 'month', p, 'week')) {
      out.push({ level: 'week', period: p });
    }
  }
  // 月底那幾天所在的週（週四可能還在當月）
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = periodsOfYmd(y, m, last).week;
  if (!out.some((s) => s.period === p) && containsPeriod(period, 'month', p, 'week')) {
    out.push({ level: 'week', period: p });
  }
  return out;
}

/** 子期間的說明文字資料：季 = 起訖月、月 = 月份、週 = 週一–週日。 */
export function slotRange(slot: Slot): { from: string; to: string } {
  const p = slot.period.split('-');
  const y = Number(p[0]);
  if (slot.level === 'quarter') {
    const q = Number(p[1]?.slice(1));
    return { from: String((q - 1) * 3 + 1), to: String(q * 3) };
  }
  if (slot.level === 'week') {
    const r = weekRange(y, Number(p[1]?.slice(1)));
    return { from: `${r.start.m}/${r.start.d}`, to: `${r.end.m}/${r.end.d}` };
  }
  const m = String(Number(p[1]));
  return { from: m, to: m };
}

// ── 首頁提示卡 ─────────────────────────────────────────────

export type Prompt = { kind: 'planYear'; year: string } | { kind: 'breakdown'; parent: PlanView };

const DAY_MS = 86_400_000;

/**
 * 首頁提示卡（ui-spec「目標 → 我的 · 首頁」），依序判斷、同時最多一張：
 * 1. 11 月起明年還沒有年目標；2. 這一季有目標但這個月沒有；3. 這個月有目標但這一週沒有；
 * 4. 下一季還空著且距季初不到 14 天（需有包含下一季的年目標）。
 */
export function nextPrompt(now: Periods, plans: PlanView[]): Prompt | null {
  const mine = plans.filter((p) => p.mine);
  const has = (level: PlanLevel, period: string) =>
    mine.some((p) => p.level === level && p.period === period);
  const first = (level: PlanLevel, period: string) =>
    mine.find((p) => p.level === level && p.period === period);
  const [y, m, d] = now.day.split('-').map(Number) as [number, number, number];
  const nextYear = String(y + 1);
  // 0. 今年還沒有年目標（v0.24：年中才開始用的人也能補今年）
  if (!has('year', String(y))) return { kind: 'planYear', year: String(y) };
  if (m >= 11 && !has('year', nextYear)) return { kind: 'planYear', year: nextYear };
  const quarter = first('quarter', now.quarter);
  if (quarter && !has('month', now.month)) return { kind: 'breakdown', parent: quarter };
  const month = first('month', now.month);
  if (month && !has('week', now.week)) return { kind: 'breakdown', parent: month };
  const q = Number(now.quarter.split('-Q')[1]);
  const nq = q === 4 ? { y: y + 1, q: 1 } : { y, q: q + 1 };
  const nqPeriod = `${nq.y}-Q${nq.q}`;
  const daysLeft = (Date.UTC(nq.y, (nq.q - 1) * 3, 1) - Date.UTC(y, m - 1, d)) / DAY_MS;
  const year = first('year', String(nq.y));
  if (year && daysLeft < 14 && !has('quarter', nqPeriod))
    return { kind: 'breakdown', parent: year };
  return null;
}

// ── 從團隊方向到這一週 ──────────────────────────────────────

export interface ChainRow {
  kind: 'direction' | 'teamGoal' | PlanLevel;
  id: string;
  title: string;
  progress: number;
  /** 上一層的標題（「為了『…』」） */
  forTitle: string | null;
  /** 這一層我還有幾個同期間的目標（> 1 時可換） */
  alternatives: number;
}

/**
 * 首頁的鏈：今年 → 這一季 → 這個月 → 這一週，各層取「選取的」或第一個（優先取上一層的子目標）；
 * 年 / 季有對齊時，最上面加上小組目標與公司方向（D47）。
 */
export function chain(
  now: Periods,
  plans: PlanView[],
  directions: Direction[],
  teamGoals: TeamGoal[],
  picked: Partial<Record<PlanLevel, string>> = {},
): ChainRow[] {
  const mine = plans.filter((p) => p.mine);
  const rows: ChainRow[] = [];
  let parent: PlanView | null = null;
  const chosen: PlanView[] = [];
  for (const level of ['year', 'quarter', 'month', 'week'] as PlanLevel[]) {
    const all = mine.filter((p) => p.level === level && p.period === now[level]);
    const kids: PlanView[] = parent ? all.filter((p) => p.parentId === parent?.id) : [];
    const pool: PlanView[] = kids.length ? kids : all;
    const item: PlanView | null = all.find((p) => p.id === picked[level]) ?? pool[0] ?? null;
    if (!item) {
      parent = null;
      continue;
    }
    rows.push({
      kind: level,
      id: item.id,
      title: item.title,
      progress: item.progress,
      forTitle: parent?.title ?? null,
      alternatives: all.length,
    });
    chosen.push(item);
    parent = item;
  }
  const alignedId = chosen.find((p) => p.alignedGoalId)?.alignedGoalId ?? null;
  if (!alignedId) return rows;
  const goal = teamGoals.find((g) => g.id === alignedId);
  const dir = directions.find((d) => d.id === (goal ? goal.directionId : alignedId));
  const top: ChainRow[] = [];
  if (dir) {
    top.push({
      kind: 'direction',
      id: dir.id,
      title: dir.title,
      progress: dir.progress,
      forTitle: null,
      alternatives: 0,
    });
  }
  if (goal) {
    top.push({
      kind: 'teamGoal',
      id: goal.id,
      title: goal.title,
      progress: goal.progress,
      forTitle: dir?.title ?? null,
      alternatives: 0,
    });
  }
  const firstRow = rows[0];
  if (firstRow && !firstRow.forTitle) firstRow.forTitle = top[top.length - 1]?.title ?? null;
  return [...top, ...rows];
}

/** 精靈第 2 步的選項：我所屬小組、同一年的小組目標。 */
export function alignOptions(teamGoals: TeamGoal[], myTeams: string[], year: string): TeamGoal[] {
  return teamGoals.filter((g) => g.year === year && myTeams.includes(g.team));
}

/** 某期間的季 / 月是否還沒有子目標（提示「先空著」）。 */
export function emptySlots(slots: Slot[], plans: PlanView[], parentId: string | null): Slot[] {
  return slots.filter(
    (s) =>
      !plans.some(
        (p) =>
          p.mine &&
          p.level === s.level &&
          p.period === s.period &&
          (!parentId || p.parentId === parentId),
      ),
  );
}

/** 「先空著，〈季前一個月月底〉會提醒你」的月份（季 Q 的前一個月；Q1 為前一年 12 月）。 */
export function remindMonth(quarterPeriod: string): number {
  const q = Number(quarterPeriod.split('-Q')[1]);
  return q === 1 ? 12 : (q - 1) * 3;
}

/** 指派選單用：某人手上未完成的任務件數（ui-spec「這一週」v0.24）。 */
export function openCount(tasks: { assignee: string | null; status: string }[], member: string) {
  return tasks.filter((x) => x.assignee === member && x.status !== 'done').length;
}

/** 規劃今年時，「分到四季」從本季開始（已過的季不列）。 */
export function remainingQuarters(year: string, now: Periods): string[] {
  const all = [1, 2, 3, 4].map((n) => `${year}-Q${n}`);
  return year === now.year ? all.filter((q) => q >= now.quarter) : all;
}
