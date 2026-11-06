import { describe, expect, it } from 'vitest';
import type { MemberView, TaskStep } from './api';
import {
  backSoon,
  climberPosition,
  defaultLook,
  defersNotifications,
  groupByHill,
  halfWidthAt,
  layoutTrail,
  MAX_PER_HILL,
  MOUNTAIN,
  moonLitPath,
  moonPhase,
  remainingFraction,
  SUMMIT,
} from './summit';

const step = (id: string, done = false): TaskStep => ({
  id,
  title: id,
  assignee: null,
  done,
  doneAt: null,
});

const member = (id: string, over: Partial<MemberView> = {}): MemberView => ({
  id,
  name: id,
  isAdmin: false,
  isMe: false,
  joinedAt: 0,
  presence: 'Online',
  note: '',
  until: null,
  location: 'remote',
  look: null,
  ...over,
});

describe('layoutTrail', () => {
  it('places checkpoints inside the mountain, bottom to top, alternating sides', () => {
    const t = layoutTrail([step('a', true), step('b'), step('c'), step('d')]);
    expect(t.points.map((p) => p.kind)).toEqual(['done', 'now', 'todo', 'todo']);
    for (const p of t.points) {
      expect(Math.abs(p.x - MOUNTAIN.apexX)).toBeLessThan(halfWidthAt(p.y));
      expect(p.y).toBeGreaterThan(SUMMIT.y);
    }
    const ys = t.points.map((p) => p.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    expect(t.points[0].side).not.toBe(t.points[1].side);
    expect(t.current).toBe(1);
  });

  it('shows at most 8 steps around the current one', () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(String(i), i < 6));
    const t = layoutTrail(steps);
    expect(t.points).toHaveLength(8);
    expect(t.hiddenBefore).toBe(4);
    expect(t.hiddenAfter).toBe(0);
    expect(t.points.find((p) => p.kind === 'now')?.index).toBe(6);
  });

  it('climber stands before the current step, or on the summit when done', () => {
    const t = layoutTrail([step('a', true), step('b')]);
    const c = climberPosition(t);
    expect(c.y).toBeGreaterThan(t.points[1].y);
    expect(c.y).toBeLessThan(t.points[0].y);
    expect(climberPosition(layoutTrail([step('a', true)]))).toEqual(SUMMIT);
  });
});

describe('groupByHill', () => {
  const offices = [
    { id: 'tpe', name: '台北辦公室' },
    { id: 'hsz', name: '新竹辦公室' },
    { id: 'empty', name: '空辦公室' },
  ];
  it('groups by office, remote, elsewhere; leave goes to the cloud', () => {
    const g = groupByHill(
      [
        member('a', { location: 'office:tpe' }),
        member('b', { location: 'office:hsz' }),
        member('c', { location: 'remote' }),
        member('d', { location: 'hidden' }),
        member('e', { location: 'office:gone' }),
        member('f', { presence: 'Leave', location: 'office:tpe' }),
      ],
      offices,
    );
    expect(g.hills.map((h) => h.id)).toEqual(['tpe', 'hsz', 'remote', 'elsewhere']);
    expect(g.hills[3].members.map((m) => m.id)).toEqual(['d', 'e']);
    expect(g.leave.map((m) => m.id)).toEqual(['f']);
  });

  it('caps each hill and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => member(`m${i}`));
    const me = member('me', { isMe: true });
    const g = groupByHill([...many, me], offices);
    expect(g.hills[0].members).toHaveLength(MAX_PER_HILL);
    expect(g.hills[0].more).toBe(4);
    expect(g.hills[0].members[0].id).toBe('me');
  });
});

describe('helpers', () => {
  it('defaultLook is stable and in range', () => {
    expect(defaultLook('abc')).toEqual(defaultLook('abc'));
    const l = defaultLook('xyz');
    expect(l.hair).toBeLessThan(8);
    expect(l.skin).toBeLessThan(4);
  });

  it('defers notifications only in meeting, lunch or focus before until', () => {
    expect(defersNotifications('Focus', null, 5)).toBe(true);
    expect(defersNotifications('Lunch', 6, 5)).toBe(true);
    expect(defersNotifications('Meeting', 5, 5)).toBe(false);
    expect(defersNotifications('Away', 9, 5)).toBe(false);
  });

  it('backSoon sorts by until within the horizon', () => {
    const list = backSoon(
      [
        member('a', { until: 30 }),
        member('b', { until: 10 }),
        member('c', { until: 99 }),
        member('d', { until: 20, presence: null }),
      ],
      5,
      50,
    );
    expect(list.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('remainingFraction clamps', () => {
    expect(remainingFraction({ createdAt: 0, dueAt: 100 }, 75)).toBeCloseTo(0.25);
    expect(remainingFraction({ createdAt: 0, dueAt: 100 }, 200)).toBe(0);
    expect(remainingFraction({ createdAt: 0, dueAt: null }, 0)).toBe(0);
  });
});

describe('moon', () => {
  it('matches known new and full moons', () => {
    const near = (p: number, target: number) =>
      Math.min(Math.abs(p - target), 1 - Math.abs(p - target));
    expect(near(moonPhase(Date.UTC(2024, 0, 11, 11, 57)), 0)).toBeLessThan(0.02);
    expect(near(moonPhase(Date.UTC(2024, 0, 25, 17, 54)), 0.5)).toBeLessThan(0.02);
    expect(near(moonPhase(Date.UTC(2026, 10, 24, 14, 53)), 0.5)).toBeLessThan(0.02);
  });
  it('draws nothing at new moon and a full disc at full moon', () => {
    expect(moonLitPath(0, 0, 0, 10)).toBeNull();
    const full = moonLitPath(0.5, 0, 0, 10) ?? '';
    // 望：左半圓（外緣）+ 右半圓（界線半寬 = r）= 整個圓
    expect(full).toBe('M0 -10A10 10 0 0 0 0 10A10 10 0 0 0 0 -10Z');
    // 上弦（漸盈）亮面在右：外緣順時針
    expect(moonLitPath(0.1, 0, 0, 10)).toMatch(/^M0 -10A10 10 0 0 1 0 10A[\d.]+ 10 0 0 0/);
    // 殘月（漸虧）亮面在左
    expect(moonLitPath(0.9, 0, 0, 10)).toMatch(/^M0 -10A10 10 0 0 0 0 10A[\d.]+ 10 0 0 1/);
  });
});
