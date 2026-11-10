/**
 * 狀態選單的純函式（ui-spec「設定」狀態選單 v0.40）：情境、跟著狀態的回來時間、效果說明、倒數。
 */
import type { PresenceState } from './api';

const MIN = 60_000;

export type SituationKey = 'back' | 'focus25' | 'meeting' | 'lunch' | 'away5' | 'away15';

export interface Situation {
  key: SituationKey;
  state: PresenceState;
  /** 回來時間（ms）；null = 不設定 */
  until: number | null;
}

/** 今天某個 `HH:MM` 的時間（本機時區）。 */
export function todayAt(hm: string, now: number): number {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
}

/** 下一個整點或半點，且至少在 `minGap` 之後。 */
export function nextHalfHour(now: number, minGap = 10 * MIN): number {
  const d = new Date(now + minGap);
  const m = d.getMinutes();
  d.setSeconds(0, 0);
  if (m === 0 || m === 30) return d.getTime();
  d.setMinutes(m < 30 ? 30 : 60);
  return d.getTime();
}

/** 情境卡（最多 6 張）。目前不是上線時第一張為「我回來了」。 */
export function situations(
  now: number,
  current: PresenceState | null,
  lunch: { start: string; end: string } | null,
): Situation[] {
  const list: Situation[] = [];
  if (current && current !== 'Online') list.push({ key: 'back', state: 'Online', until: null });
  list.push({ key: 'focus25', state: 'Focus', until: now + 25 * MIN });
  list.push({ key: 'meeting', state: 'Meeting', until: nextHalfHour(now) });
  if (lunch && now < todayAt(lunch.end, now)) {
    list.push({ key: 'lunch', state: 'Lunch', until: todayAt(lunch.end, now) });
  }
  list.push({ key: 'away5', state: 'Away', until: now + 5 * MIN });
  if (list.length < 6) list.push({ key: 'away15', state: 'Away', until: now + 15 * MIN });
  return list;
}

export type UntilOption =
  | { kind: 'minutes'; m: number }
  | { kind: 'at'; label: ':30' | ':00'; ms: number }
  | { kind: 'lunchEnd'; ms: number };

/** 跟著狀態的回來時間選項（C）。休假改用日期，不在此列。 */
export function untilOptions(
  state: PresenceState,
  now: number,
  lunch: { start: string; end: string } | null,
): UntilOption[] {
  const half = (target: 0 | 30): UntilOption => {
    const d = new Date(now + 5 * MIN);
    d.setSeconds(0, 0);
    if (target === 30) {
      if (d.getMinutes() > 30) d.setHours(d.getHours() + 1);
      d.setMinutes(30);
    } else {
      d.setHours(d.getHours() + 1, 0);
    }
    return { kind: 'at', label: target === 30 ? ':30' : ':00', ms: d.getTime() };
  };
  switch (state) {
    case 'Focus':
      return [25, 50, 90].map((m) => ({ kind: 'minutes', m }));
    case 'Meeting':
      return [half(30), half(0), { kind: 'minutes', m: 30 }];
    case 'Lunch':
      return lunch
        ? [{ kind: 'lunchEnd', ms: todayAt(lunch.end, now) }]
        : [{ kind: 'minutes', m: 60 }];
    case 'Away':
      return [5, 15, 30].map((m) => ({ kind: 'minutes', m }));
    case 'Busy':
      return [30, 60].map((m) => ({ kind: 'minutes', m }));
    default:
      return [];
  }
}

export const optionTime = (o: UntilOption, now: number): number =>
  o.kind === 'minutes' ? now + o.m * MIN : o.ms;

/** 目前狀態的效果說明（D）：回傳 i18n key。 */
export function effectKey(
  state: PresenceState | null,
  until: number | null,
):
  | 'status.effect.defer'
  | 'status.effect.deferOpen'
  | 'status.effect.away'
  | 'status.effect.busy'
  | 'status.effect.online'
  | 'status.effect.leave' {
  switch (state) {
    case 'Focus':
    case 'Meeting':
    case 'Lunch':
      return until ? 'status.effect.defer' : 'status.effect.deferOpen';
    case 'Away':
      return 'status.effect.away';
    case 'Busy':
      return 'status.effect.busy';
    case 'Leave':
      return 'status.effect.leave';
    default:
      return 'status.effect.online';
  }
}

/** 是否該自動回上線（E）：有回來時間、已到期、且不是休假或上線。 */
export function shouldAutoReturn(
  state: PresenceState | null,
  until: number | null,
  now: number,
): boolean {
  return !!state && state !== 'Online' && state !== 'Leave' && until !== null && until <= now;
}

/** 倒數環的比例（0–1）與剩餘分鐘；`since` 是設定當下（記在本機），沒有時以剩餘時間為全長。 */
export function countdown(
  until: number | null,
  now: number,
  since: number | null,
): { ratio: number; minutes: number } | null {
  if (until === null || until <= now) return null;
  const left = until - now;
  const total = since !== null && since < now && until > since ? until - since : left;
  return { ratio: Math.min(1, left / total), minutes: Math.ceil(left / MIN) };
}

const SINCE_KEY = 'hills.status.since';

/** 記錄設定回來時間的當下（倒數環的起點，只存本機）。 */
export function writeSince(until: number | null, now = Date.now()): void {
  try {
    if (until === null) localStorage.removeItem(SINCE_KEY);
    else localStorage.setItem(SINCE_KEY, JSON.stringify({ until, since: now }));
  } catch {
    // 只影響倒數環的顯示
  }
}

export function readSince(until: number | null): number | null {
  try {
    const raw = localStorage.getItem(SINCE_KEY);
    if (!raw || until === null) return null;
    const v = JSON.parse(raw) as { until?: number; since?: number };
    return v.until === until && typeof v.since === 'number' ? v.since : null;
  } catch {
    return null;
  }
}
