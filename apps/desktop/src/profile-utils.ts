/**
 * 個人資料的純函式（technical-design §16.17，D57）：時區、工作日、非工作時段。
 */
import type { MemberProfile, WorkHours } from './api';

export const DEFAULT_HOURS: WorkHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

export const emptyProfile = (): MemberProfile => ({
  displayName: '',
  timezone: '',
  workHours: { ...DEFAULT_HOURS, days: [...DEFAULT_HOURS.days] },
  updatedAt: 0,
});

/** 這台電腦的時區（IANA）。 */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 是否為瀏覽器認得的 IANA 時區（空字串 = 跟著裝置，視為有效）。 */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 可選的時區清單（支援時用 Intl，否則只列常用的幾個）。 */
export function timezoneOptions(current: string): string[] {
  let list: string[];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    list = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  if (list.length === 0) {
    list = [
      'Asia/Taipei',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Europe/London',
      'America/New_York',
      'America/Los_Angeles',
      'UTC',
    ];
  }
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

export const effectiveTimezone = (p: Pick<MemberProfile, 'timezone'> | null | undefined) =>
  p?.timezone || deviceTimezone();

/** 某個時區現在的星期（1 = 週一 … 7 = 週日）與 `HH:MM`。 */
export function localClock(ms: number, tz: string): { weekday: number; hhmm: string } {
  const fmt = (zone?: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(ms);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(tz || undefined);
  } catch {
    parts = fmt(undefined);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    weekday: names.indexOf(get('weekday')) + 1,
    hhmm: `${get('hour')}:${get('minute')}`,
  };
}

/** 今天是不是本人的工作日（依本人時區）。沒有個人資料時沿用週一到週五。 */
export function isMyWorkday(p: MemberProfile | null, ms: number): boolean {
  const hours = p?.workHours ?? DEFAULT_HOURS;
  return hours.days.includes(localClock(ms, effectiveTimezone(p)).weekday);
}

/** 對方現在是否不在工作時段；沒有個人資料時視為在工作時段（§16.17）。 */
export function isOffHours(p: MemberProfile | null | undefined, ms: number): boolean {
  if (!p) return false;
  const { weekday, hhmm } = localClock(ms, effectiveTimezone(p));
  const h = p.workHours;
  return !h.days.includes(weekday) || hhmm < h.start || hhmm >= h.end;
}

export function validHours(h: WorkHours): boolean {
  const ok = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  return ok(h.start) && ok(h.end) && h.start < h.end && new Set(h.days).size === h.days.length;
}
