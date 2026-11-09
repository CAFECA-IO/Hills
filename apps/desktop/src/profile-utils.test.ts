import { describe, expect, it } from 'vitest';
import type { MemberProfile } from './api';
import { isMyWorkday, isOffHours, isValidTimezone, localClock, validHours } from './profile-utils';

const p = (over: Partial<MemberProfile> = {}): MemberProfile => ({
  displayName: '',
  timezone: 'Asia/Taipei',
  workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  updatedAt: 1,
  ...over,
});

// 2026-11-09 是週一；台北 = UTC+8
const at = (iso: string) => Date.parse(iso);

describe('profile utils', () => {
  it('reads the local clock in a time zone', () => {
    expect(localClock(at('2026-11-09T02:30:00Z'), 'Asia/Taipei')).toEqual({
      weekday: 1,
      hhmm: '10:30',
    });
    expect(localClock(at('2026-11-09T02:30:00Z'), 'America/Los_Angeles').weekday).toBe(7);
  });

  it('off hours by day and time', () => {
    expect(isOffHours(p(), at('2026-11-09T02:30:00Z'))).toBe(false);
    expect(isOffHours(p(), at('2026-11-09T11:00:00Z'))).toBe(true); // 19:00
    expect(isOffHours(p(), at('2026-11-08T02:30:00Z'))).toBe(true); // 週日
    expect(isOffHours(undefined, at('2026-11-08T02:30:00Z'))).toBe(false);
  });

  it('work days follow the member', () => {
    const sat = at('2026-11-14T02:00:00Z');
    expect(isMyWorkday(p(), sat)).toBe(false);
    expect(isMyWorkday(p({ workHours: { days: [6], start: '09:00', end: '18:00' } }), sat)).toBe(
      true,
    );
  });

  it('validates time zones and hours', () => {
    expect(isValidTimezone('')).toBe(true);
    expect(isValidTimezone('Asia/Taipei')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(validHours({ days: [1], start: '18:00', end: '09:00' })).toBe(false);
    expect(validHours({ days: [1, 1], start: '09:00', end: '18:00' })).toBe(false);
    expect(validHours({ days: [], start: '09:00', end: '18:00' })).toBe(true);
  });
});
