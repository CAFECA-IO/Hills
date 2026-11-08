/** 目標「階梯」的純函式（ui-spec「目標」、technical-design §16.10）。 */
import type { PlanLevel, PlanView, Task } from './api';

export const LEVELS: PlanLevel[] = ['year', 'quarter', 'month', 'week', 'day'];

export type Periods = Record<PlanLevel, string>;

/** 某時間點在指定時區的年月日。時區無效時用本機時區。 */
export function ymdIn(ms: number, tz: string): { y: number; m: number; d: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(ms);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(ms);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 週（週一開始；跨年週屬於含週四的那一年）。 */
export function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7; // 1 = 週一 … 7 = 週日
  date.setUTCDate(date.getUTCDate() + 4 - dow); // 移到同週的週四
  const year = date.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((date.getTime() - jan1) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** 一個日期（以組織時區的年月日表示）對應的五個期間字串。 */
export function periodsOfYmd(y: number, m: number, d: number): Periods {
  const w = isoWeek(y, m, d);
  return {
    year: String(y),
    quarter: `${y}-Q${Math.ceil(m / 3)}`,
    month: `${y}-${pad(m)}`,
    week: `${w.year}-W${pad(w.week)}`,
    day: `${y}-${pad(m)}-${pad(d)}`,
  };
}

export function periodsAt(ms: number, tz: string): Periods {
  const { y, m, d } = ymdIn(ms, tz);
  return periodsOfYmd(y, m, d);
}

/** 期間的短標籤（欄頭用）。 */
export function periodLabel(level: PlanLevel, period: string): string {
  const parts = period.split('-');
  switch (level) {
    case 'year':
      return parts[0] ?? period;
    case 'quarter':
      return parts[1] ?? period;
    case 'month':
      return String(Number(parts[1]));
    case 'week':
      return parts[1] ?? period;
    case 'day':
      return `${Number(parts[1])}/${Number(parts[2])}`;
  }
}

export function nextLevel(level: PlanLevel): PlanLevel | null {
  return LEVELS[LEVELS.indexOf(level) + 1] ?? null;
}

export function prevLevel(level: PlanLevel): PlanLevel | null {
  const i = LEVELS.indexOf(level);
  return i > 0 ? (LEVELS[i - 1] ?? null) : null;
}

/** 每一層目前選取的項目 id（選取某層時清除更下層）。 */
export type Selection = Partial<Record<PlanLevel, string>>;

export function select(sel: Selection, level: PlanLevel, id: string | null): Selection {
  const out: Selection = {};
  for (const l of LEVELS) {
    if (l === level) {
      if (id) out[l] = id;
      break;
    }
    if (sel[l]) out[l] = sel[l];
  }
  return out;
}

/**
 * 一欄要顯示的項目：該層、該期間；上一層有選取時只列出對齊它的子目標（ui-spec「目標」）。
 */
export function columnItems(
  items: PlanView[],
  level: PlanLevel,
  periods: Periods,
  sel: Selection,
): PlanView[] {
  const prev = prevLevel(level);
  const parent = prev ? sel[prev] : undefined;
  return items.filter(
    (i) => i.level === level && i.period === periods[level] && (!parent || i.parentId === parent),
  );
}

/** 日欄的任務：今天到期（組織時區）或今天的焦點，未完成。 */
export function todayTasks(tasks: Task[], focusId: string | null, day: string, tz: string): Task[] {
  return tasks.filter((t) => {
    if (t.status === 'done') return false;
    if (t.id === focusId) return true;
    if (t.dueAt === null) return false;
    return periodsAt(t.dueAt, tz).day === day;
  });
}

/** 編輯對話框「對齊上層」的選項：上一層中包含此期間的項目（我的）。 */
export function parentOptions(items: PlanView[], level: PlanLevel, period: string): PlanView[] {
  const prev = prevLevel(level);
  if (!prev) return [];
  return items.filter(
    (i) => i.mine && i.level === prev && containsPeriod(i.period, prev, period, level),
  );
}

/** 上層期間是否包含下層期間（週以週四所在月份判斷所屬月 / 季 / 年）。 */
export function containsPeriod(
  outer: string,
  outerLevel: PlanLevel,
  inner: string,
  innerLevel: PlanLevel,
): boolean {
  const ymd = representativeYmd(inner, innerLevel);
  if (!ymd) return false;
  return periodsOfYmd(ymd.y, ymd.m, ymd.d)[outerLevel] === outer;
}

/** 期間中的代表日：日 = 該日、週 = 週四、月 / 季 / 年 = 第一天。 */
function representativeYmd(
  period: string,
  level: PlanLevel,
): { y: number; m: number; d: number } | null {
  const p = period.split('-');
  const y = Number(p[0]);
  if (!y) return null;
  switch (level) {
    case 'year':
      return { y, m: 1, d: 1 };
    case 'quarter':
      return { y, m: (Number(p[1]?.slice(1)) - 1) * 3 + 1, d: 1 };
    case 'month':
      return { y, m: Number(p[1]), d: 1 };
    case 'day':
      return { y, m: Number(p[1]), d: Number(p[2]) };
    case 'week': {
      const w = Number(p[1]?.slice(1));
      // ISO 第 1 週的週四 = 1 月 4 日所在週的週四
      const jan4 = new Date(Date.UTC(y, 0, 4));
      const dow = jan4.getUTCDay() || 7;
      const thu = new Date(Date.UTC(y, 0, 4 + (4 - dow) + (w - 1) * 7));
      return { y: thu.getUTCFullYear(), m: thu.getUTCMonth() + 1, d: thu.getUTCDate() };
    }
  }
}

// ── 編輯對話框的期間選擇器（ui-spec「目標」v0.17） ─────────────

/** 年份選項：基準年的前 1 年到後 2 年，另含目前值（排序、去重）。 */
export function yearOptions(base: number, current?: number): number[] {
  const set = new Set([base - 1, base, base + 1, base + 2]);
  if (current && Number.isFinite(current)) set.add(current);
  return [...set].sort((a, b) => a - b);
}

/** ISO 年的週數（52 或 53）：12 月 28 日所在的週。 */
export function weeksInYear(y: number): number {
  return isoWeek(y, 12, 28).week;
}

/** ISO 週的週一與週日（年月日）。 */
export function weekRange(
  y: number,
  w: number,
): { start: { y: number; m: number; d: number }; end: { y: number; m: number; d: number } } {
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(Date.UTC(y, 0, 4 - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7));
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const ymd = (d: Date) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  return { start: ymd(mon), end: ymd(sun) };
}

/** 期間拆成選擇器的欄位：年、以及季 / 月 / 週的序號（年層級為 0）。日層級回傳原字串。 */
export function splitPeriod(level: PlanLevel, period: string): { year: number; n: number } {
  const p = period.split('-');
  const year = Number(p[0]) || 0;
  switch (level) {
    case 'quarter':
    case 'week':
      return { year, n: Number(p[1]?.slice(1)) || 1 };
    case 'month':
      return { year, n: Number(p[1]) || 1 };
    default:
      return { year, n: 0 };
  }
}

/** 由年與序號組回期間字串（季 / 月 / 週；年層級忽略序號）。 */
export function joinPeriod(level: PlanLevel, year: number, n: number): string {
  switch (level) {
    case 'year':
      return String(year);
    case 'quarter':
      return `${year}-Q${n}`;
    case 'month':
      return `${year}-${pad(n)}`;
    case 'week':
      return `${year}-W${pad(Math.min(n, weeksInYear(year)))}`;
    case 'day':
      return '';
  }
}

/**
 * 換層級時推算新層級的期間：原期間包含錨點日（目前檢視的日期）時用錨點日所在的期間，
 * 否則取原期間的第一天（週取週一）。
 */
export function periodsFromAny(period: string, level: PlanLevel, anchor?: Periods): Periods {
  if (anchor && containsPeriod(period, level, anchor.day, 'day')) return anchor;
  const p = period.split('-');
  const y = Number(p[0]) || new Date().getFullYear();
  if (level === 'week') {
    const s = weekRange(y, Number(p[1]?.slice(1)) || 1).start;
    return periodsOfYmd(s.y, s.m, s.d);
  }
  let m = 1;
  let d = 1;
  if (level === 'quarter') m = (Number(p[1]?.slice(1)) - 1) * 3 + 1 || 1;
  if (level === 'month' || level === 'day') m = Number(p[1]) || 1;
  if (level === 'day') d = Number(p[2]) || 1;
  return periodsOfYmd(y, m, d);
}
