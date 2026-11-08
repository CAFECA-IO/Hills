/**
 * 方向摘要與偏離的純函式（technical-design §16.14 v0.21，D47 第 2 批；design-system §9「方向羅盤」）：
 * 本人摘要的計算、四項檢查、方向羅盤的平面轉換與人像錯開。
 */
import type {
  DirectionRules,
  DirectionWeek,
  GoalBrief,
  MemberDirection,
  PlanView,
  Task,
} from './api';
import { periodsAt, type Periods } from './goals-utils';

export const DEFAULT_RULES: DirectionRules = {
  minAlignedShare: 50,
  behindPoints: 25,
  staleDays: 14,
};

const DAY_MS = 86_400_000;

// ── 本人的摘要 ─────────────────────────────────────────────

/** 一個週目標往上（週 → 月 → 季 → 年）是否有任一層對齊團隊方向。 */
export function chainAligned(planId: string | null, byId: Map<string, PlanView>): boolean {
  const seen = new Set<string>();
  let cur = planId ? byId.get(planId) : undefined;
  while (cur && !seen.has(cur.id)) {
    if (cur.alignedGoalId) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** 季目標的對齊：自己沒有時沿用年目標的（§16.14）。 */
function quarterAligned(q: PlanView, byId: Map<string, PlanView>): string | null {
  if (q.alignedGoalId) return q.alignedGoalId;
  const parent = q.parentId ? byId.get(q.parentId) : undefined;
  return parent?.alignedGoalId ?? null;
}

/**
 * 計算本人這週的方向摘要（§16.14）。`plans` 是我看得到的計劃（含同事的，用來追連結的週目標），
 * `tasks` 是我看得到的任務（小組 + 私人）；週與季依組織時區 `tz`。
 */
export function computeSummary(
  me: string,
  plans: PlanView[],
  tasks: Task[],
  tz: string,
  now: number,
): Omit<DirectionWeek, 'updatedAt'> {
  const periods = periodsAt(now, tz);
  const byId = new Map(plans.map((p) => [p.id, p]));
  const inWeek = (ms: number | null) => ms !== null && periodsAt(ms, tz).week === periods.week;
  let units = 0;
  let alignedUnits = 0;
  let lastActivity = 0;
  for (const t of tasks) {
    const aligned = chainAligned(t.planItemId, byId);
    if (t.steps.length === 0) {
      if (t.assignee === me && t.status === 'done') {
        if (t.doneAt) lastActivity = Math.max(lastActivity, t.doneAt);
        if (inWeek(t.doneAt)) {
          units++;
          if (aligned) alignedUnits++;
        }
      }
      continue;
    }
    for (const s of t.steps) {
      const who = s.assignee ?? t.assignee;
      if (who !== me || !s.done) continue;
      if (s.doneAt) lastActivity = Math.max(lastActivity, s.doneAt);
      if (inWeek(s.doneAt)) {
        units++;
        if (aligned) alignedUnits++;
      }
    }
  }
  const mine = plans.filter((p) => p.mine);
  for (const p of mine) lastActivity = Math.max(lastActivity, p.updatedAt);
  const quarters = mine.filter((p) => p.level === 'quarter' && p.period === periods.quarter);
  const open = quarters.filter((q) => q.visibility.kind !== 'private');
  const goals: GoalBrief[] = open.map((q) => ({
    id: q.id,
    title: q.title,
    progress: clamp(q.progress),
    alignedGoalId: quarterAligned(q, byId),
  }));
  const alignedQ = quarters.filter((q) => quarterAligned(q, byId));
  const pool = alignedQ.length ? alignedQ : quarters;
  const quarterProgress = pool.length
    ? clamp(pool.reduce((a, q) => a + q.progress, 0) / pool.length)
    : null;
  const myOpen = tasks.filter((t) => t.assignee === me && t.status !== 'done');
  const dueThisWeek = myOpen.filter((t) => inWeek(t.dueAt)).length;
  return {
    v: 1,
    week: periods.week,
    units,
    alignedUnits,
    quarterProgress,
    goals,
    privateGoals: quarters.length - open.length,
    lastActivity,
    openTasks: myOpen.length,
    dueThisWeek,
  };
}

const clamp = (v: number) => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));

/** 兩份摘要內容是否相同（不比 updatedAt）。 */
export function sameSummary(
  a: Omit<DirectionWeek, 'updatedAt'> | null | undefined,
  b: Omit<DirectionWeek, 'updatedAt'> | null | undefined,
): boolean {
  if (!a || !b) return false;
  const strip = (x: Omit<DirectionWeek, 'updatedAt'>) => {
    const { updatedAt: _u, v: _v, ...rest } = x as DirectionWeek;
    void _u;
    void _v;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

// ── 四項檢查 ───────────────────────────────────────────────

export type DriftState = 'ok' | 'warn' | 'stale' | 'unknown';

export interface Assessment {
  state: DriftState;
  /** 角度 0–90°；本週沒有完成的事為 0 */
  angle: number;
  /** 本週為了團隊方向的比例（0–100）；沒有完成的事為 null */
  share: number | null;
  /** 季目標進度（0–100）；沒有季目標為 null */
  progress: number | null;
  unaligned: boolean;
  elsewhere: boolean;
  behind: boolean;
  stale: boolean;
  /** 距離最後活動幾天 */
  idleDays: number | null;
  week: DirectionWeek | null;
}

/** 本季經過的比例（0–1），以組織時區的今天計算。 */
export function quarterElapsed(periods: Periods): number {
  const [y, m, d] = periods.day.split('-').map(Number) as [number, number, number];
  const q = Math.ceil(m / 3);
  const start = Date.UTC(y, (q - 1) * 3, 1);
  const end = Date.UTC(y, q * 3, 1);
  return Math.max(0, Math.min(1, (Date.UTC(y, m - 1, d) + DAY_MS / 2 - start) / (end - start)));
}

/** 四項檢查（§16.14）。`weeks` 由新到舊。 */
export function assess(
  weeks: DirectionWeek[] | undefined,
  rules: DirectionRules,
  periods: Periods,
  now: number,
): Assessment {
  const latest = weeks?.[0] ?? null;
  if (!latest) {
    return {
      state: 'unknown',
      angle: 0,
      share: null,
      progress: null,
      unaligned: false,
      elsewhere: false,
      behind: false,
      stale: false,
      idleDays: null,
      week: null,
    };
  }
  const thisWeek = latest.week === periods.week ? latest : null;
  const share =
    thisWeek && thisWeek.units > 0 ? (thisWeek.alignedUnits * 100) / thisWeek.units : null;
  const progress = latest.quarterProgress;
  const unaligned = latest.goals.every((g) => !g.alignedGoalId) && latest.privateGoals === 0;
  const elsewhere = share !== null && share < rules.minAlignedShare;
  const behind = progress !== null && progress < quarterElapsed(periods) * 100 - rules.behindPoints;
  const idleDays =
    latest.lastActivity > 0 ? Math.floor((now - latest.lastActivity) / DAY_MS) : null;
  const stale = idleDays === null || idleDays >= rules.staleDays;
  const state: DriftState = stale ? 'stale' : unaligned || elsewhere || behind ? 'warn' : 'ok';
  return {
    state,
    angle: share === null ? 0 : 90 * (1 - share / 100),
    share,
    progress,
    unaligned,
    elsewhere,
    behind,
    stale,
    idleDays,
    week: latest,
  };
}

/** 依狀態排序：太久沒更新、可能偏離在前。 */
export function stateRank(s: DriftState): number {
  return { stale: 0, warn: 1, ok: 2, unknown: 3 }[s];
}

export function summariesByMember(list: MemberDirection[]): Map<string, DirectionWeek[]> {
  return new Map(list.map((m) => [m.member, m.weeks]));
}

// ── 方向羅盤的幾何（design-system §9） ─────────────────────

export interface Plane {
  cx: number;
  cy: number;
  /** 地面旋轉（度） */
  rot: number;
  /** 垂直壓扁比例 */
  squash: number;
}

/** 平面座標（以中心為原點、往前為負 y）：角度 a（度）、半徑 r、左右 side（−1 / 1）。 */
export function flat(a: number, r: number, side: number): [number, number] {
  const rad = (a * Math.PI * side) / 180;
  return [Math.sin(rad) * r, -Math.cos(rad) * r];
}

/** 平面 → 畫面：先旋轉、再壓扁。 */
export function toScreen(p: Plane, x: number, y: number): [number, number] {
  const t = (p.rot * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [p.cx + (x * c - y * s), p.cy + p.squash * (x * s + y * c)];
}

export interface Pin {
  key: string;
  /** 地面點 */
  x: number;
  y: number;
  /** 人像底部位置（推開後） */
  ax: number;
  ay: number;
}

/** 人像重疊時左右推開（簡單的成對排斥，最多 120 輪）。 */
export function layoutPins(
  pins: { key: string; x: number; y: number }[],
  stem: number,
  w: number,
  h: number,
): Pin[] {
  const out: Pin[] = pins.map((p) => ({ ...p, ax: p.x, ay: p.y - stem }));
  for (let round = 0; round < 120; round++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const dx = b.ax - a.ax;
        const dy = b.ay - a.ay;
        if (Math.abs(dx) < w && Math.abs(dy) < h) {
          const push = (w - Math.abs(dx)) / 2 + 0.5;
          const sgn = dx >= 0 ? 1 : -1;
          a.ax -= sgn * push * 0.6;
          b.ax += sgn * push * 0.6;
          const upper = dy >= 0 ? a : b;
          upper.ay -= push * 0.25;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return out;
}

/** 多人的平均方向（向量平均，度；正 = 偏右）。第 4 批「大家實際走向」使用。 */
export function meanAngle(items: { angle: number; side: number }[]): number | null {
  if (items.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const i of items) {
    const [x, y] = flat(i.angle, 1, i.side);
    sx += x;
    sy += y;
  }
  return (Math.atan2(sx, -sy) * 180) / Math.PI;
}

/** 每個人固定往左或右（由 id 決定，讓箭頭分散在兩側）。 */
export function sideOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 2 === 0 ? -1 : 1;
}
