/**
 * 目標的四個引導流程（ui-spec「工作 › 目標的引導流程」v0.46，D67；technical-design §16.10 v0.36）：
 * 建議的下一步、規劃哪一期、拆解建議、可用時間、回顧與延期。純函式。
 */
import type { PlanInput, PlanLevel, PlanReview, PlanView, Task } from './api';
import { childSlots, type Slot } from './goals-guided-utils';
import { containsPeriod, periodsAt, periodsOfYmd, weekRange, type Periods } from './goals-utils';
import { workMinutesOf } from './work-utils';

const DAY_MS = 86_400_000;
const ymd = (day: string) => day.split('-').map(Number) as [number, number, number];
const pad = (n: number) => String(n).padStart(2, '0');

/** 不做了的目標保留紀錄，但不算「這一期已經有目標」。 */
export const isDropped = (p: PlanView) => p.review?.outcome === 'dropped';
const active = (plans: PlanView[]) => plans.filter((p) => p.mine && !isDropped(p));

// ── 期間 ───────────────────────────────────────────────────

/** 同層的下 / 上 n 期。 */
export function shiftPeriod(level: PlanLevel, period: string, n: number): string {
  if (level === 'year') return String(Number(period) + n);
  if (level === 'quarter') {
    const [y, q] = period.split('-Q').map(Number) as [number, number];
    const i = y * 4 + (q - 1) + n;
    return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
  }
  if (level === 'month') {
    const [y, m] = period.split('-').map(Number) as [number, number];
    const i = y * 12 + (m - 1) + n;
    return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
  }
  const [ys, ws] = period.split('-W');
  const r = weekRange(Number(ys), Number(ws));
  const mon = new Date(Date.UTC(r.start.y, r.start.m - 1, r.start.d + 7 * n));
  return periodsOfYmd(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate()).week;
}

/** 期間的最後一天（週為週日）。 */
export function lastDay(level: PlanLevel, period: string): string {
  if (level === 'year') return `${period}-12-31`;
  if (level === 'week') {
    const [ys, ws] = period.split('-W');
    const e = weekRange(Number(ys), Number(ws)).end;
    return `${e.y}-${pad(e.m)}-${pad(e.d)}`;
  }
  const y = Number(period.slice(0, 4));
  const m = level === 'quarter' ? Number(period.split('-Q')[1]) * 3 : Number(period.slice(5));
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(d)}`;
}

const daysUntil = (from: string, to: string) => {
  const [a, b, c] = ymd(from);
  const [d, e, f] = ymd(to);
  return Math.round((Date.UTC(d, e - 1, f) - Date.UTC(a, b - 1, c)) / DAY_MS);
};

// ── 期末回顧 ───────────────────────────────────────────────

export interface ReviewWindow {
  level: 'month' | 'quarter';
  period: string;
}

/** 回顧期間：每月最後 4 天、每季最後 7 天（季優先）。 */
export function reviewWindow(now: Periods): ReviewWindow | null {
  if (daysUntil(now.day, lastDay('quarter', now.quarter)) < 7)
    return { level: 'quarter', period: now.quarter };
  if (daysUntil(now.day, lastDay('month', now.month)) < 4)
    return { level: 'month', period: now.month };
  return null;
}

/** 要回顧的目標：回顧期間內、還沒回顧過的我的目標（季回顧也包含該季最後一個月）。 */
export function reviewItems(w: ReviewWindow, plans: PlanView[]): PlanView[] {
  const lastMonth = w.level === 'quarter' ? lastDay('quarter', w.period).slice(0, 7) : w.period;
  return plans.filter(
    (p) =>
      p.mine &&
      !p.review &&
      ((p.level === w.level && p.period === w.period) ||
        (p.level === 'month' && p.period === lastMonth)),
  );
}

// ── 建議的下一步 ───────────────────────────────────────────

export type NextStep =
  | { kind: 'review'; window: ReviewWindow; items: PlanView[] }
  | { kind: 'planYear'; year: string }
  | { kind: 'plan'; level: 'quarter' | 'month'; period: string }
  | { kind: 'breakdown'; parent: PlanView };

/**
 * 首頁「建議的下一步」（ui-spec v0.46）：回顧期間 → 年（D47 規則）→ 本期或下一期還沒有季 / 月目標
 * （季：本季最後一個月看下一季；月：15 日後看下個月）→ 本月目標還沒拆到週。
 */
export function nextStep(now: Periods, plans: PlanView[]): NextStep | null {
  const mine = active(plans);
  const has = (level: PlanLevel, period: string) =>
    mine.some((p) => p.level === level && p.period === period);
  const w = reviewWindow(now);
  if (w) {
    const items = reviewItems(w, mine);
    if (items.length) return { kind: 'review', window: w, items };
  }
  const [y, m, d] = ymd(now.day);
  if (!has('year', String(y))) return { kind: 'planYear', year: String(y) };
  if (m >= 11 && !has('year', String(y + 1))) return { kind: 'planYear', year: String(y + 1) };
  if (!has('quarter', now.quarter)) return { kind: 'plan', level: 'quarter', period: now.quarter };
  const nextQ = shiftPeriod('quarter', now.quarter, 1);
  if (m % 3 === 0 && !has('quarter', nextQ))
    return { kind: 'plan', level: 'quarter', period: nextQ };
  if (!has('month', now.month)) return { kind: 'plan', level: 'month', period: now.month };
  const nextM = shiftPeriod('month', now.month, 1);
  if (d >= 15 && !has('month', nextM)) return { kind: 'plan', level: 'month', period: nextM };
  const month = mine.find(
    (p) => p.level === 'month' && p.period === now.month && !p.done && !p.review,
  );
  if (month && !mine.some((p) => p.parentId === month.id))
    return { kind: 'breakdown', parent: month };
  return null;
}

// ── ① 規劃新的一期 ─────────────────────────────────────────

export interface PeriodOption {
  level: PlanLevel;
  period: string;
  /** 這一期還沒有我的目標 */
  empty: boolean;
}

/** 「要規劃哪一期？」：本期與下一期的季、月、週（年另走年度精靈）。 */
export function periodOptions(now: Periods, plans: PlanView[]): PeriodOption[] {
  const mine = active(plans);
  const opt = (level: PlanLevel, period: string): PeriodOption => ({
    level,
    period,
    empty: !mine.some((p) => p.level === level && p.period === period),
  });
  return [
    opt('quarter', now.quarter),
    opt('quarter', shiftPeriod('quarter', now.quarter, 1)),
    opt('month', now.month),
    opt('month', shiftPeriod('month', now.month, 1)),
    opt('week', now.week),
    opt('week', shiftPeriod('week', now.week, 1)),
  ];
}

const PARENT: Partial<Record<PlanLevel, PlanLevel>> = {
  quarter: 'year',
  month: 'quarter',
  week: 'month',
};

/** 「它要推動哪一個上一層目標？」：包含這一期的上一層目標（不含不做了的）。 */
export function parentChoices(plans: PlanView[], level: PlanLevel, period: string): PlanView[] {
  const up = PARENT[level];
  if (!up) return [];
  return active(plans).filter((p) => p.level === up && containsPeriod(p.period, up, period, level));
}

export interface TitleSuggestion {
  kind: 'kr' | 'carry';
  title: string;
  /** 關鍵結果的 krRef 或上一期目標 id */
  ref: string;
  note: string;
}

/** 「不知道怎麼寫？」：上一層還沒完成的關鍵結果，加上上一期同一個上一層下沒做完的目標。 */
export function titleSuggestions(
  plans: PlanView[],
  parent: PlanView | null,
  level: PlanLevel,
  period: string,
): TitleSuggestion[] {
  const out: TitleSuggestion[] = [];
  if (parent) {
    for (const k of parent.keyResults) {
      const ref = `${parent.id}/${k.id}`;
      const v = parent.krProgress[k.id] ?? 0;
      if (v < 100) out.push({ kind: 'kr', title: k.title, ref, note: `${Math.round(v)}%` });
    }
  }
  const prev = shiftPeriod(level, period, -1);
  for (const p of active(plans)) {
    if (p.level !== level || p.period !== prev || p.done || p.progress >= 100) continue;
    if (parent && p.parentId !== parent.id) continue;
    out.push({ kind: 'carry', title: p.title, ref: p.id, note: `${Math.round(p.progress)}%` });
  }
  return out;
}

/** 「期末時，怎麼知道做到了？」 */
export type DoneRule = 'tasks' | 'number' | 'self';

/** 依完成方式組出新目標（季：一個關鍵結果；月 / 週：自己回報時先填 0%）。 */
export function newPlanInput(a: {
  level: PlanLevel;
  period: string;
  title: string;
  parent: PlanView | null;
  krRef: string | null;
  rule: DoneRule;
  target: number;
  unit: string;
  visibility: PlanInput['visibility'];
}): PlanInput {
  const okr = a.level === 'year' || a.level === 'quarter';
  return {
    level: a.level,
    period: a.period,
    title: a.title.trim(),
    parentId: a.parent?.id ?? null,
    krRef: okr ? null : a.krRef,
    done: false,
    progressOverride: a.rule === 'self' ? 0 : null,
    keyResults:
      a.rule === 'number'
        ? [
            {
              id: '',
              title: a.title.trim(),
              start: 0,
              target: a.target,
              current: 0,
              unit: a.unit.trim(),
              manual: true,
            },
          ]
        : [],
    alignedGoalId: okr ? (a.parent?.alignedGoalId ?? null) : null,
    criteria: [],
    helps: [],
    review: null,
    visibility: a.visibility,
  };
}

// ── ② 拆到下一層 ───────────────────────────────────────────

export interface ChildDraft {
  slot: Slot;
  title: string;
  /** 預設勾選：沒過的期間、不是跨年週、還沒有子目標 */
  on: boolean;
  /** 期限落在這一期、會連上這個新目標的任務 */
  tasks: string[];
}

/** 週的可用分鐘：工作時間（D57）加總。 */
export function weekCapacity(
  week: string,
  hours: { days: number[]; start: string; end: string } | null | undefined,
): number {
  const [ys, ws] = week.split('-W');
  const s = weekRange(Number(ys), Number(ws)).start;
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(s.y, s.m - 1, s.d + i));
    total += workMinutesOf(
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      hours,
    );
  }
  return total;
}

const dayOfMs = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** 期間的第一天。 */
export function firstDay(level: PlanLevel, period: string): string {
  const [y, m, d] = ymd(lastDay(level, shiftPeriod(level, period, -1)));
  return dayOfMs(Date.UTC(y, m - 1, d + 1));
}

/**
 * 「看建議的分法」：每個下一層期間一列。依序填入期限落在該期間的我的任務、
 * 上一層還沒完成的關鍵結果（輪流），都沒有則空白。
 */
export function suggestChildren(
  parent: PlanView,
  plans: PlanView[],
  tasks: Task[],
  me: string,
  today: string,
  tz: string,
): ChildDraft[] {
  const slots = childSlots(parent.level, parent.period);
  const krs = parent.keyResults.filter((k) => (parent.krProgress[k.id] ?? 0) < 100);
  const existing = active(plans).filter((p) => p.parentId === parent.id);
  let kr = 0;
  return slots.map((slot) => {
    const from = firstDay(slot.level, slot.period);
    const to = lastDay(slot.level, slot.period);
    const due = tasks.filter(
      (x) =>
        x.status !== 'done' &&
        x.assignee === me &&
        x.dueAt !== null &&
        periodsAt(x.dueAt, tz).day >= from &&
        periodsAt(x.dueAt, tz).day <= to,
    );
    let title = '';
    if (due.length)
      title = due
        .slice(0, 2)
        .map((x) => x.title)
        .join('、');
    else if (krs.length) title = krs[kr++ % krs.length]!.title;
    const crossYear = from.slice(0, 4) !== to.slice(0, 4);
    const taken = existing.some((p) => p.period === slot.period);
    return {
      slot,
      title,
      on: to >= today && !crossYear && !taken && Boolean(title),
      tasks: due.map((x) => x.id),
    };
  });
}

// ── ③ 調整 與 ④ 回顧 ──────────────────────────────────────

/** 延到下一期時新建的目標（同上一層、同關鍵結果、同可見度）。 */
export function carryInput(item: PlanView): PlanInput {
  return {
    level: item.level,
    period: shiftPeriod(item.level, item.period, 1),
    title: item.title,
    parentId: item.parentId,
    krRef: item.krRef,
    done: false,
    progressOverride: null,
    keyResults: item.keyResults.map((k) => ({ ...k, id: '' })),
    alignedGoalId: item.alignedGoalId,
    criteria: item.criteria.map((c) => ({ ...c, id: '' })),
    helps: [],
    review: null,
    visibility: item.visibility,
  };
}

/**
 * 寫入回顧結果的目標（technical-design §16.10 v0.36）：進度覆寫為 percent；月 / 週同時標為完成。
 */
export function withReview(
  input: PlanInput,
  outcome: PlanReview['outcome'],
  percent: number,
  note: string,
  carriedTo: string | null = null,
): PlanInput {
  const okr = input.level === 'year' || input.level === 'quarter';
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return {
    ...input,
    done: okr ? input.done : true,
    progressOverride: p,
    review: { outcome, percent: p, note: note.trim(), carriedTo, at: 0 },
  };
}

/** 回顧結果的件數（摘要）。 */
export function reviewCounts(list: { outcome: PlanReview['outcome']; carried: boolean }[]) {
  return {
    achieved: list.filter((x) => x.outcome === 'achieved').length,
    partial: list.filter((x) => x.outcome === 'partial').length,
    missed: list.filter((x) => x.outcome === 'missed').length,
    dropped: list.filter((x) => x.outcome === 'dropped').length,
    carried: list.filter((x) => x.carried).length,
  };
}
