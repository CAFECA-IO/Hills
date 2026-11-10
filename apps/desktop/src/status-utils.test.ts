import { describe, expect, it } from 'vitest';
import {
  countdown,
  effectKey,
  nextHalfHour,
  optionTime,
  shouldAutoReturn,
  situations,
  untilOptions,
} from './status-utils';

const at = (h: number, m: number) => new Date(2026, 10, 10, h, m, 0, 0).getTime();
const MIN = 60_000;

describe('status menu (ui-spec v0.40)', () => {
  it('next half hour is at least 10 minutes away', () => {
    expect(nextHalfHour(at(11, 2))).toBe(at(11, 30));
    expect(nextHalfHour(at(11, 25))).toBe(at(12, 0));
    expect(nextHalfHour(at(11, 20))).toBe(at(11, 30));
  });

  it('situations: back first when not online; lunch only before its end', () => {
    const lunch = { start: '12:00', end: '13:30' };
    const a = situations(at(11, 0), 'Focus', lunch).map((s) => s.key);
    expect(a).toEqual(['back', 'focus25', 'meeting', 'lunch', 'away5', 'away15']);
    const b = situations(at(14, 0), 'Online', lunch).map((s) => s.key);
    expect(b).toEqual(['focus25', 'meeting', 'away5', 'away15']);
    expect(situations(at(11, 0), 'Online', lunch).find((s) => s.key === 'lunch')?.until).toBe(
      at(13, 30),
    );
  });

  it('return-time options follow the status', () => {
    const now = at(11, 2);
    expect(untilOptions('Focus', now, null).map((o) => optionTime(o, now))).toEqual([
      now + 25 * MIN,
      now + 50 * MIN,
      now + 90 * MIN,
    ]);
    const meet = untilOptions('Meeting', now, null).map((o) => optionTime(o, now));
    expect(meet).toEqual([at(11, 30), at(12, 0), now + 30 * MIN]);
    expect(untilOptions('Lunch', now, { start: '12:00', end: '13:30' })).toEqual([
      { kind: 'lunchEnd', ms: at(13, 30) },
    ]);
    expect(untilOptions('Leave', now, null)).toEqual([]);
  });

  it('effect text keys', () => {
    expect(effectKey('Focus', 1)).toBe('status.effect.defer');
    expect(effectKey('Meeting', null)).toBe('status.effect.deferOpen');
    expect(effectKey('Away', 1)).toBe('status.effect.away');
    expect(effectKey(null, null)).toBe('status.effect.online');
  });

  it('auto return only for expired, non-leave statuses', () => {
    expect(shouldAutoReturn('Focus', at(11, 0), at(11, 1))).toBe(true);
    expect(shouldAutoReturn('Focus', at(11, 2), at(11, 1))).toBe(false);
    expect(shouldAutoReturn('Leave', at(11, 0), at(11, 1))).toBe(false);
    expect(shouldAutoReturn('Online', at(11, 0), at(11, 1))).toBe(false);
    expect(shouldAutoReturn('Away', null, at(11, 1))).toBe(false);
  });

  it('countdown uses the local start when known', () => {
    expect(countdown(at(11, 25), at(11, 15), at(11, 0))).toEqual({ ratio: 0.4, minutes: 10 });
    expect(countdown(at(11, 25), at(11, 15), null)).toEqual({ ratio: 1, minutes: 10 });
    expect(countdown(at(11, 0), at(11, 15), null)).toBeNull();
  });
});
