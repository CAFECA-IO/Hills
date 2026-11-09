/** 路線圖的純函式（ui-spec「目標 → 進階檢視：路線圖」v0.21，D47 第 3 批）。 */
import type { PlanLevel } from './api';
import { childSlots } from './goals-guided-utils';
import { weekRange, splitPeriod, type Periods } from './goals-utils';

export type Zoom = 'year' | 'quarter' | 'month' | 'week';

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export interface Col {
  /** 期間字串：月 `YYYY-MM`、週 `YYYY-Www`、日 `YYYY-MM-DD`；週縮放的「未排日期」為 `none` */
  key: string;
  label: string;
  /** 上方分組（季 / 月），相同者合併標頭 */
  group: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 各縮放的子層級（格子裡放的東西）。 */
export const CHILD: Record<Exclude<Zoom, 'week'>, PlanLevel> = {
  year: 'quarter',
  quarter: 'month',
  month: 'week',
};

/** 往前 / 後移動一個期間。 */
export function shift(zoom: Zoom, at: Ymd, dir: number): Ymd {
  if (zoom === 'week') {
    const d = new Date(Date.UTC(at.y, at.m - 1, at.d + dir * 7));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  const months = zoom === 'year' ? 12 : zoom === 'quarter' ? 3 : 1;
  const d = new Date(Date.UTC(at.y, at.m - 1 + dir * months, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: 1 };
}

/** 週的週四所在月份（ISO 週所屬的月）。 */
export function monthOfWeek(week: string): string {
  const { year, n } = splitPeriod('week', week);
  const r = weekRange(year, n).start;
  const thu = new Date(Date.UTC(r.y, r.m - 1, r.d + 3));
  return `${thu.getUTCFullYear()}-${pad(thu.getUTCMonth() + 1)}`;
}

/** 月份所在的季。 */
export function quarterOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** 某縮放的欄。 */
export function columns(zoom: Zoom, p: Periods): Col[] {
  if (zoom === 'year') {
    const y = Number(p.year);
    return Array.from({ length: 12 }, (_, i) => ({
      key: `${y}-${pad(i + 1)}`,
      label: String(i + 1),
      group: `Q${Math.ceil((i + 1) / 3)}`,
    }));
  }
  if (zoom === 'quarter') {
    return childSlots('quarter', p.quarter).flatMap((m) =>
      childSlots('month', m.period).map((w) => ({
        key: w.period,
        label: `W${w.period.slice(-2)}`,
        group: m.period,
      })),
    );
  }
  if (zoom === 'month') {
    return childSlots('month', p.month).map((w) => ({
      key: w.period,
      label: `W${w.period.slice(-2)}`,
      group: p.month,
    }));
  }
  const { year, n } = splitPeriod('week', p.week);
  const s = weekRange(year, n).start;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(s.y, s.m - 1, s.d + i));
    return {
      key: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      group: p.week,
    };
  });
  return [...days, { key: 'none', label: '', group: p.week }];
}

/** 子目標在欄上的範圍 [起, 迄]（含）；不在範圍內回傳 null。 */
export function spanOf(zoom: Zoom, period: string, cols: Col[]): [number, number] | null {
  const idx = (pred: (c: Col) => boolean) => {
    const list = cols.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
    return list.length ? ([list[0]!, list[list.length - 1]!] as [number, number]) : null;
  };
  if (zoom === 'year') return idx((c) => quarterOfMonth(c.key) === period);
  if (zoom === 'quarter') return idx((c) => monthOfWeek(c.key) === period);
  if (zoom === 'month') return idx((c) => c.key === period);
  return idx((c) => c.key === period);
}

/** 欄 → 子目標的期間（在那一欄新增或移到那一欄時用）。 */
export function periodOfCol(zoom: Exclude<Zoom, 'week'>, col: string): string {
  if (zoom === 'year') return quarterOfMonth(col);
  if (zoom === 'quarter') return monthOfWeek(col);
  return col;
}

/** 期限（毫秒，本機時間）所在的日欄；不在這週回傳 `none`。 */
export function dayCol(dueAt: number | null, cols: Col[]): string {
  if (dueAt === null) return 'none';
  const d = new Date(dueAt);
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return cols.some((c) => c.key === key) ? key : 'none';
}

/** 日欄的期限：當天 18:00（本機時間）；`none` 為沒有期限。 */
export function dueOfCol(key: string): number | null {
  return key === 'none' ? null : new Date(`${key}T18:00`).getTime();
}

/** 把有範圍的項目分到不重疊的列（貪婪法），回傳每個項目的列號。 */
export function packRows(spans: [number, number][]): number[] {
  const ends: number[] = [];
  return spans.map(([a, b]) => {
    let row = ends.findIndex((end) => end < a);
    if (row < 0) {
      row = ends.length;
      ends.push(b);
    } else {
      ends[row] = b;
    }
    return row;
  });
}

/** 某縮放的期間標籤資料。 */
export function zoomPeriod(zoom: Zoom, p: Periods): string {
  return zoom === 'year'
    ? p.year
    : zoom === 'quarter'
      ? p.quarter
      : zoom === 'month'
        ? p.month
        : p.week;
}

export function ymdOf(p: Periods): Ymd {
  const [y, m, d] = p.day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** 期間的第一天（放大到某個目標時當作錨點）。 */
export function startOf(level: PlanLevel, period: string): Ymd {
  const parts = period.split('-');
  const y = Number(parts[0]);
  if (level === 'quarter') return { y, m: (Number(parts[1]?.slice(1)) - 1) * 3 + 1, d: 1 };
  if (level === 'month') return { y, m: Number(parts[1]), d: 1 };
  if (level === 'week') {
    const s = weekRange(y, Number(parts[1]?.slice(1))).start;
    return s;
  }
  return { y, m: 1, d: 1 };
}
