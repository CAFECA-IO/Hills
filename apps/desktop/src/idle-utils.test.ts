import { describe, expect, it } from 'vitest';
import { idleStep } from './idle-utils';

const now = 10_000_000;

describe('idleStep', () => {
  it('stops the timer at the moment idling started', () => {
    expect(idleStep({ running: true, idleSince: null }, 900, now)).toEqual({
      kind: 'pause',
      at: now - 900_000,
    });
    expect(idleStep({ running: true, idleSince: null }, 899, now)).toBeNull();
  });
  it('asks once the person is back', () => {
    expect(idleStep({ running: false, idleSince: now - 20 * 60_000 }, 5, now)).toEqual({
      kind: 'ask',
      since: now - 20 * 60_000,
      minutes: 20,
    });
    expect(idleStep({ running: false, idleSince: now - 60_000 }, 120, now)).toBeNull();
  });
  it('does nothing without an idle reading or when not timing', () => {
    expect(idleStep({ running: true, idleSince: null }, null, now)).toBeNull();
    expect(idleStep({ running: false, idleSince: null }, 5000, now)).toBeNull();
  });
});
