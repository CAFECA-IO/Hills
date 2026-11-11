/**
 * 往山丘走（ui-spec「工作 › 小組 › 方向」v0.42，D59；technical-design §16.14 v0.34；design-system §9）：
 * 狀態判定與場景位置。
 */
import type { DirectionRules, DirectionWeek, MemberView } from './api';
import { assess, sideOf, weekAngle, type Assessment } from './drift-utils';
import type { Periods } from './goals-utils';

export type HillKind =
  'onTrack' | 'slow' | 'veered' | 'backwards' | 'stopped' | 'unknown' | 'leave';

/** 統計與說明的順序（需要注意的在前）。 */
export const HILL_KINDS: HillKind[] = [
  'stopped',
  'backwards',
  'veered',
  'slow',
  'onTrack',
  'unknown',
];

export interface Walker {
  member: MemberView;
  kind: HillKind;
  a: Assessment;
  /** 季目標進度 0–100 */
  progress: number;
  /** 上週的季目標進度（往後退的依據） */
  prev: number | null;
  /** 偏離角度 0–90 */
  angle: number;
  /** 每人固定在左或右（-1 / 1） */
  side: number;
  /** 前三週（舊 → 新） */
  trail: { progress: number; angle: number }[];
}

/**
 * 狀態依序判定（§16.14 v0.34）：休假 → 還沒有資料 → 停下來 → 往後退（比上週低 1 個百分點以上）
 * → 方向歪了 → 走太慢 → 在路上。
 */
export function walkerOf(
  member: MemberView,
  weeks: DirectionWeek[] | undefined,
  rules: DirectionRules,
  periods: Periods,
  now: number,
): Walker {
  const a = assess(weeks, rules, periods, now);
  const cur = weeks?.[0]?.quarterProgress ?? null;
  const prev = weeks?.[1]?.quarterProgress ?? null;
  let kind: HillKind;
  if (member.presence === 'Leave') kind = 'leave';
  else if (a.state === 'unknown') kind = 'unknown';
  else if (a.stale) kind = 'stopped';
  else if (cur !== null && prev !== null && cur <= prev - 1) kind = 'backwards';
  else if (a.unaligned || a.elsewhere) kind = 'veered';
  else if (a.behind) kind = 'slow';
  else kind = 'onTrack';
  const trail = (weeks ?? [])
    .slice(1, 4)
    .map((w) => ({ progress: w.quarterProgress ?? 0, angle: weekAngle(w) ?? 0 }))
    .reverse();
  return {
    member,
    kind,
    a,
    progress: cur ?? 0,
    prev,
    angle: a.angle,
    side: sideOf(member.id),
    trail,
  };
}

/** 場景座標（viewBox 1000 × 600）：起點 y = 575，山腳（100%）y = 235。 */
export const SCENE = { w: 1000, h: 600, start: 575, summit: 235, cx: 500 };

/** 小路在某個 y 的半寬：底部 125、山腳 25（偏 45° 以內在小路上）。 */
export function pathHalfWidth(y: number): number {
  const t = (y - SCENE.summit) / (SCENE.start - SCENE.summit);
  return 25 + Math.max(0, Math.min(1, t)) * 125;
}

export function yOf(progress: number): number {
  const p = Math.max(0, Math.min(100, progress));
  return SCENE.start - (p / 100) * (SCENE.start - SCENE.summit);
}

/** 角色位置與縮放：往前 = 進度，左右 = 角度（45° = 小路邊），越遠越小（0.7–1）。 */
export function posOf(
  progress: number,
  angle: number,
  side: number,
): { x: number; y: number; scale: number } {
  const y = yOf(progress);
  const x = SCENE.cx + side * (Math.min(90, angle) / 45) * pathHalfWidth(y);
  const t = (y - SCENE.summit) / (SCENE.start - SCENE.summit);
  return { x: Math.max(60, Math.min(SCENE.w - 60, x)), y, scale: 0.7 + 0.3 * t };
}

/** 各狀態人數（休假不列入）。 */
export function countsOf(walkers: Walker[]): Record<HillKind, number> {
  const out: Record<HillKind, number> = {
    onTrack: 0,
    slow: 0,
    veered: 0,
    backwards: 0,
    stopped: 0,
    unknown: 0,
    leave: 0,
  };
  for (const w of walkers) out[w.kind]++;
  return out;
}

/** 需要注意的排前面：停下來、往後退、方向歪了、走太慢、在路上、沒資料、休假。 */
export function rankOf(k: HillKind): number {
  return k === 'leave' ? 99 : HILL_KINDS.indexOf(k);
}

/** 標籤寬度估計：中日韓字 13、其他 7.5（字級 12）。 */
export function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? 13 : 7.5;
  return Math.max(60, Math.round(w + 20));
}

export interface LabelIn {
  id: string;
  x: number;
  y: number;
  w: number;
  side: number;
}

/** 標籤不重疊：依序嘗試原位、上下各 26 的位移，取第一個不撞的。 */
export function placeLabels(items: LabelIn[], h = 24): Map<string, { x: number; y: number }> {
  const placed: { x0: number; x1: number; y: number }[] = [];
  const out = new Map<string, { x: number; y: number }>();
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (const it of sorted) {
    const x0 = it.side > 0 ? it.x + 22 : it.x - 22 - it.w;
    const x1 = x0 + it.w;
    const base = it.y - 52;
    let y = base;
    for (let k = 0; k < 16; k++) {
      const off = k === 0 ? 0 : (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * (h + 2);
      const cand = base + off;
      if (!placed.some((p) => p.x0 < x1 && x0 < p.x1 && Math.abs(p.y - cand) < h + 2)) {
        y = cand;
        break;
      }
    }
    placed.push({ x0, x1, y });
    out.set(it.id, { x: x0, y });
  }
  return out;
}
