import { describe, expect, it } from 'vitest';
import type { DirectionWeek, MemberView } from './api';
import { DEFAULT_RULES } from './drift-utils';
import { periodsAt } from './goals-utils';
import { countsOf, pathHalfWidth, posOf, rankOf, walkerOf, yOf, SCENE } from './hill-utils';

const NOW = Date.parse('2026-11-11T04:00:00Z');
const periods = periodsAt(NOW, 'Asia/Taipei');

const member = (id: string, extra: Partial<MemberView> = {}): MemberView => ({
  id,
  name: id,
  rosterName: id,
  isAdmin: false,
  isMe: false,
  joinedAt: 0,
  presence: 'Online',
  note: '',
  until: null,
  location: 'office',
  look: null,
  ...extra,
});

const week = (w: string, q: number | null, extra: Partial<DirectionWeek> = {}): DirectionWeek => ({
  week: w,
  units: 4,
  alignedUnits: 4,
  quarterProgress: q,
  goals: [{ id: 'g', title: 'g', progress: q ?? 0, alignedGoalId: 'tg' }],
  privateGoals: 0,
  lastActivity: NOW - 3600_000,
  openTasks: 1,
  dueThisWeek: 1,
  updatedAt: NOW,
  ...extra,
});

describe('hill-utils', () => {
  it('judges states in order', () => {
    const w = (weeks: DirectionWeek[] | undefined, m = member('a')) =>
      walkerOf(m, weeks, DEFAULT_RULES, periods, NOW).kind;
    expect(w(undefined)).toBe('unknown');
    expect(w([week(periods.week, 60)], member('a', { presence: 'Leave' }))).toBe('leave');
    expect(w([week(periods.week, 60, { lastActivity: NOW - 30 * 86_400_000 })])).toBe('stopped');
    expect(w([week(periods.week, 44), week('2026-W45', 52)])).toBe('backwards');
    expect(w([week(periods.week, 60, { alignedUnits: 1 })])).toBe('veered');
    expect(w([week(periods.week, 5)])).toBe('slow');
    expect(w([week(periods.week, 60), week('2026-W45', 55)])).toBe('onTrack');
  });

  it('places walkers on the path and sorts attention first', () => {
    expect(yOf(0)).toBe(SCENE.start);
    expect(yOf(100)).toBe(SCENE.summit);
    // 偏 45° = 小路邊
    const p = posOf(0, 45, 1);
    expect(p.x).toBeCloseTo(SCENE.cx + pathHalfWidth(SCENE.start));
    expect(posOf(100, 0, -1).scale).toBeCloseTo(0.7);
    expect(rankOf('stopped')).toBeLessThan(rankOf('onTrack'));
    expect(rankOf('leave')).toBeGreaterThan(rankOf('unknown'));
    const ws = [
      walkerOf(member('a'), [week(periods.week, 60)], DEFAULT_RULES, periods, NOW),
      walkerOf(member('b'), [week(periods.week, 5)], DEFAULT_RULES, periods, NOW),
    ];
    expect(countsOf(ws).onTrack).toBe(1);
    expect(countsOf(ws).slow).toBe(1);
  });
});
