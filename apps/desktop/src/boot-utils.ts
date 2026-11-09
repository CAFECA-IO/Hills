/**
 * 啟動畫面（ui-spec「啟動畫面」v0.26；design-system §9「啟動動畫」v0.5）：
 * 隨機版本（不重複上次）與 C 方向羅盤每一格的幾何。
 */

export const BOOT_VARIANTS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export type BootVariant = (typeof BOOT_VARIANTS)[number];

const LAST_KEY = 'hills.boot.last';

export function isBootVariant(v: unknown): v is BootVariant {
  return typeof v === 'string' && (BOOT_VARIANTS as readonly string[]).includes(v);
}

/** 從六個版本中排除上次的，隨機選一個（`rand` ∈ [0, 1)）。 */
export function pickBoot(last: string | null, rand: number): BootVariant {
  const pool = BOOT_VARIANTS.filter((v) => v !== last);
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand * pool.length)));
  return pool[i] ?? 'a';
}

export function readLastBoot(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function writeLastBoot(v: BootVariant) {
  try {
    localStorage.setItem(LAST_KEY, v);
  } catch {
    // 無法記錄時下次可能重複，不影響啟動
  }
}

// ── C 方向羅盤：與 design-system §9「方向羅盤」相同的透視 ──────────

export const COMPASS = { cx: 200, cy: 184, r: 170, squash: 66 / 170, rot: (-6 * Math.PI) / 180 };

/** 平面上的方向（度，0 = 團隊方向）與長度 → 畫面座標。 */
export function compassPoint(deg: number, len: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const x = len * Math.sin(a);
  const y = -len * Math.cos(a) * COMPASS.squash;
  const { cx, cy, rot } = COMPASS;
  return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const outBack = (x: number) => 1 + 2.5 * Math.pow(x - 1, 3) + 1.5 * Math.pow(x - 1, 2);
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const round = (n: number) => Math.round(n * 10) / 10;

const PEOPLE = [
  { from: -84, to: -14, len: 0.78 },
  { from: 72, to: 9, len: 0.92 },
  { from: -46, to: 24, len: 0.6 },
  { from: 108, to: -3, len: 0.7 },
] as const;

export interface CompassArm {
  x: number;
  y: number;
  /** 人像中心（含落下的位移） */
  px: number;
  py: number;
  opacity: number;
  /** 進入在路上範圍後的 ✓ */
  ok: number;
}

export interface CompassFrame {
  arms: CompassArm[];
  mean: { x: number; y: number; opacity: number };
  pulse: { scale: number; opacity: number };
  /** 0 連線 / 1 同步方向 / 2 大家都在路上 */
  stage: 0 | 1 | 2;
}

/** 一輪動畫中 t ∈ [0, 1) 的畫面：人像依序落下、擺進扇形，畫出平均方向，地面泛起波紋。 */
export function compassFrame(t: number): CompassFrame {
  const seg = (a: number, b: number) => clamp((t - a) / (b - a));
  const fade = 1 - seg(0.9, 0.99);
  let sum = 0;
  const arms = PEOPLE.map((p, i) => {
    const drop = inOut(seg(0.04 + i * 0.06, 0.16 + i * 0.06));
    const swing = outBack(seg(0.3 + i * 0.075, 0.48 + i * 0.075));
    const deg = p.from + (p.to - p.from) * swing;
    sum += deg;
    const [x, y] = compassPoint(deg, COMPASS.r * p.len * drop);
    return {
      x: round(x),
      y: round(y),
      px: round(x),
      py: round(y - 22 - (1 - drop) * 46),
      opacity: round(Math.min(drop * 2, 1) * fade * 100) / 100,
      ok: round(seg(0.48 + i * 0.075, 0.53 + i * 0.075) * 100) / 100,
    };
  });
  const grow = inOut(seg(0.68, 0.8));
  const [mx, my] = compassPoint(sum / PEOPLE.length, COMPASS.r * 0.98 * Math.max(grow, 0.001));
  const p = seg(0.74, 0.92);
  return {
    arms,
    mean: { x: round(mx), y: round(my), opacity: round(grow * fade * 100) / 100 },
    pulse: {
      scale: 0.4 + 0.65 * p,
      opacity: p > 0 && p < 1 ? round(0.8 * (1 - p) * 100) / 100 : 0,
    },
    stage: t < 0.28 ? 0 : t < 0.66 ? 1 : 2,
  };
}
