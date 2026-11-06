/**
 * 首頁焦點山的純函式（ui-spec「首頁」、technical-design §5.1 / §16.8 v0.11）：
 * 角色外觀預設值、山路檢查點座標、山丘分組、延後通知判斷、回來時間排序。
 */
import type { Look, MemberView, OfficeView, PresenceState, Task, TaskStep } from './api';

/** 外觀色盤大小（team.rs LOOK_PALETTE、tokens.css --hills-hair-0…7）。 */
export const LOOK_PALETTE = 8;

/** 尚未設定外觀的成員：由 ID 決定（每個人看到的都一樣）。 */
export function defaultLook(id: string): Look {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return {
    hair: h % LOOK_PALETTE,
    shirt: (h >>> 8) % LOOK_PALETTE,
    skin: (h >>> 16) % 4,
  };
}

export const lookOf = (m: Pick<MemberView, 'id' | 'look'>): Look => m.look ?? defaultLook(m.id);

/** 會議、午休、專注中，且回來時間未到 → 對方會延後通知，按鈕顯示「敲門」。 */
export function defersNotifications(
  state: PresenceState | null,
  until: number | null,
  now: number,
): boolean {
  return (
    (state === 'Meeting' || state === 'Lunch' || state === 'Focus') &&
    (until === null || until > now)
  );
}

// ── 焦點山幾何（viewBox 760 × 640） ─────────────────────────

export const SCENE = { w: 760, h: 640 } as const;
export const MOUNTAIN = { apexX: 380, apexY: 186, baseY: 560, baseHalf: 300 } as const;
export const SUMMIT = { x: MOUNTAIN.apexX, y: MOUNTAIN.apexY + 10 } as const;
const TRAIL_START = { x: 250, y: 548 } as const;
const MAX_SHOWN = 8;

/** 山在高度 y 的半寬。 */
export const halfWidthAt = (y: number) =>
  ((y - MOUNTAIN.apexY) / (MOUNTAIN.baseY - MOUNTAIN.apexY)) * MOUNTAIN.baseHalf;

export interface Checkpoint {
  step: TaskStep;
  /** 在任務中的索引 */
  index: number;
  x: number;
  y: number;
  /** 標籤放在檢查點的哪一側 */
  side: 'left' | 'right';
  kind: 'done' | 'now' | 'todo';
}

export interface Trail {
  start: { x: number; y: number };
  points: Checkpoint[];
  /** 未畫出的步驟數（前 / 後） */
  hiddenBefore: number;
  hiddenAfter: number;
  /** 第一個未完成步驟的索引（全部完成時為 steps.length） */
  current: number;
}

/** 依步驟數排出之字形山路：由下往上，左右交錯，都在山體內。 */
export function layoutTrail(steps: TaskStep[]): Trail {
  const current = steps.findIndex((s) => !s.done);
  const cur = current === -1 ? steps.length : current;
  let from = 0;
  if (steps.length > MAX_SHOWN) {
    from = Math.min(Math.max(cur - 2, 0), steps.length - MAX_SHOWN);
  }
  const shown = steps.slice(from, from + MAX_SHOWN);
  const n = shown.length;
  const top = SUMMIT.y + 70;
  const bottom = 500;
  const points = shown.map((step, i) => {
    const y = n === 1 ? (top + bottom) / 2 : bottom - ((bottom - top) * i) / (n - 1);
    const right = i % 2 === 0;
    const x = MOUNTAIN.apexX + (right ? 1 : -1) * halfWidthAt(y) * 0.55;
    const index = from + i;
    return {
      step,
      index,
      x: Math.round(x),
      y: Math.round(y),
      side: right ? ('right' as const) : ('left' as const),
      kind: step.done ? ('done' as const) : index === cur ? ('now' as const) : ('todo' as const),
    };
  });
  return {
    start: TRAIL_START,
    points,
    hiddenBefore: from,
    hiddenAfter: steps.length - from - n,
    current: cur,
  };
}

/** 自己的角色站的位置：目前步驟前一段路的 70% 處；全部完成時站在山頂。 */
export function climberPosition(trail: Trail): { x: number; y: number } {
  const idx = trail.points.findIndex((p) => p.kind === 'now');
  if (idx === -1) {
    return trail.points.length && trail.points.every((p) => p.kind === 'done')
      ? SUMMIT
      : trail.start;
  }
  const to = trail.points[idx];
  const from = idx === 0 ? trail.start : trail.points[idx - 1];
  const k = 0.7;
  return {
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
  };
}

// ── 山腳的辦公室山丘 ────────────────────────────────────────

export const MAX_PER_HILL = 8;

export interface Hill {
  /** office id，或 `remote` / `elsewhere` */
  id: string;
  name: string | null;
  kind: 'office' | 'remote' | 'elsewhere';
  members: MemberView[];
  /** 超過上限、合併為「+N」的人數 */
  more: number;
}

export interface Grouping {
  hills: Hill[];
  /** 休假中（站在雲上） */
  leave: MemberView[];
}

/** 依地點分組：辦公室（依設定順序）→ 遠端 → 未標示地點；休假者在雲上；空的辦公室不畫。 */
export function groupByHill(members: MemberView[], offices: OfficeView[]): Grouping {
  const known = new Set(offices.map((o) => o.id));
  const leave: MemberView[] = [];
  const buckets = new Map<string, MemberView[]>();
  for (const m of members) {
    if (m.presence === 'Leave') {
      leave.push(m);
      continue;
    }
    const off = m.location.startsWith('office:') ? m.location.slice(7) : null;
    const key = off && known.has(off) ? off : m.location === 'remote' ? 'remote' : 'elsewhere';
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }
  const make = (id: string, name: string | null, kind: Hill['kind']): Hill | null => {
    const list = buckets.get(id) ?? [];
    if (list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) =>
        Number(b.isMe) - Number(a.isMe) ||
        Number(a.presence === null) - Number(b.presence === null) ||
        a.name.localeCompare(b.name),
    );
    return {
      id,
      name,
      kind,
      members: sorted.slice(0, MAX_PER_HILL),
      more: Math.max(0, sorted.length - MAX_PER_HILL),
    };
  };
  const hills = [
    ...offices.map((o) => make(o.id, o.name, 'office')),
    make('remote', null, 'remote'),
    make('elsewhere', null, 'elsewhere'),
  ].filter((h): h is Hill => h !== null);
  return { hills, leave };
}

/** 有回來時間、尚未回來的成員（由近到遠），只看到 `horizon` 為止。 */
export function backSoon(members: MemberView[], now: number, horizon: number): MemberView[] {
  return members
    .filter((m) => m.presence !== null && m.until !== null && m.until > now && m.until <= horizon)
    .sort((a, b) => (a.until ?? 0) - (b.until ?? 0));
}

/** 倒數環：距期限剩餘時間占「建立到期限」的比例（0–1）。 */
export function remainingFraction(task: Pick<Task, 'createdAt' | 'dueAt'>, now: number): number {
  if (task.dueAt === null) return 0;
  const total = task.dueAt - task.createdAt;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (task.dueAt - now) / total));
}

// ── 月相（ui-spec「視覺語言」日夜） ─────────────────────────

const SYNODIC_DAYS = 29.530588853;
/** 2000-01-06 18:14 UTC 的朔 */
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);

/** 月齡比例：0 = 朔、0.5 = 望（0 ≤ p < 1）。 */
export function moonPhase(ms: number): number {
  const days = (ms - NEW_MOON_EPOCH) / 86_400_000;
  const p = (days / SYNODIC_DAYS) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * 月亮亮面的 SVG path（北半球視角：漸盈亮面在右）。朔附近回傳 null（看不到亮面）。
 * 外緣半圓 + 明暗界線的橢圓弧，界線半寬為 r·|cos 2πp|。
 */
export function moonLitPath(p: number, cx: number, cy: number, r: number): string | null {
  const lit = (1 - Math.cos(2 * Math.PI * p)) / 2;
  if (lit < 0.02) return null;
  const waxing = p < 0.5;
  const crescent = lit < 0.5;
  const rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
  const outer = waxing ? 1 : 0;
  const term = waxing === crescent ? 0 : 1;
  const f = (n: number) => Math.round(n * 100) / 100;
  return `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 0 ${outer} ${f(cx)} ${f(cy + r)}A${f(rx)} ${f(r)} 0 0 ${term} ${f(cx)} ${f(cy - r)}Z`;
}
