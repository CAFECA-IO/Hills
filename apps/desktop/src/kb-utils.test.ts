import { describe, expect, it } from 'vitest';
import type { KbCategory, KbItem, KbTopic } from './api';
import {
  activeCategories,
  activityDays,
  isoWeekOfMonday,
  yearStats,
  citations,
  layout,
  matches,
  placeOf,
  relations,
  summary,
  upToWeek,
  weekly,
} from './kb-utils';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 8, 4); // 2026-W45

const cat = (id: string, resolved = id): KbCategory => ({ id, name: id, createdAt: 0, resolved });
const topic = (id: string, categoryId: string, resolved = id): KbTopic => ({
  id,
  name: id,
  categoryId,
  createdAt: 0,
  resolved,
});
const item = (key: string, topicId: string, extra: Partial<KbItem> = {}): KbItem => ({
  key,
  author: 'a',
  title: key,
  body: '',
  format: 'markdown',
  spec: null,
  tags: [],
  topicId,
  refs: [],
  source: { kind: 'manual' },
  createdAt: T0,
  updatedAt: T0,
  updatedBy: 'a',
  ...extra,
});

const cats = [cat('eng'), cat('dev', 'eng'), cat('ops')];
const topics = [topic('st', 'eng'), topic('st2', 'eng', 'st'), topic('dep', 'ops')];

describe('places and relations', () => {
  it('follows merges', () => {
    expect(activeCategories(cats).map((c) => c.id)).toEqual(['eng', 'ops']);
    expect(placeOf(item('x', 'st2'), topics).topic?.id).toBe('st');
    expect(placeOf(item('x', 'gone'), topics)).toEqual({ topic: null, categoryId: null });
  });
  it('counts citations once per citing item, ignoring missing and self', () => {
    const items = [
      item('a', 'st'),
      item('b', 'st', { refs: ['a', 'a', 'zz'] }),
      item('c', 'dep', { refs: ['a', 'c'] }),
    ];
    const c = citations(items);
    expect(c.get('a')).toBe(2);
    expect(c.get('c')).toBeUndefined();
  });
  it('lists the four relation kinds with priority', () => {
    const conv = { kind: 'message' as const, convId: 'k', messageKey: 'm' };
    const items = [
      item('a', 'st', { source: conv }),
      item('b', 'dep', { refs: ['a'] }),
      item('c', 'dep', { source: { kind: 'file', convId: 'k', attachment: null } }),
      item('d', 'st2'),
      item('e', 'dep'),
    ];
    expect(relations(items[0]!, items, topics)).toEqual([
      { key: 'b', kind: 'ref' },
      { key: 'c', kind: 'conv' },
      { key: 'd', kind: 'topic' },
    ]);
  });
});

describe('timeline', () => {
  const items = [
    item('a', 'st', { createdAt: T0 - 14 * DAY }),
    item('b', 'st', { createdAt: T0 - DAY }),
    item('c', 'st', { createdAt: T0 }),
  ];
  it('counts per ISO week up to now', () => {
    const w = weekly(items, T0, 'Asia/Taipei');
    expect(w.map((x) => x.week)).toEqual(['2026-W43', '2026-W44', '2026-W45']);
    expect(w.map((x) => x.count)).toEqual([1, 0, 2]);
  });
  it('filters up to a week', () => {
    expect(upToWeek(items, '2026-W44', 'Asia/Taipei').map((i) => i.key)).toEqual(['a']);
    expect(upToWeek(items, null, 'Asia/Taipei')).toHaveLength(3);
  });
});

describe('text helpers', () => {
  it('searches title, body and tags', () => {
    const i = item('relay', 'st', { body: '部署 **步驟**', tags: ['Docker'] });
    expect(matches(i, 'docker')).toBe(true);
    expect(matches(i, '步驟')).toBe(true);
    expect(matches(i, 'nope')).toBe(false);
  });
  it('summarises markdown', () => {
    expect(summary('# 標題\n\n**粗體** `code`')).toBe('標題 粗體 code');
    expect(summary('字'.repeat(100), 10)).toBe(`${'字'.repeat(10)}…`);
  });
});

describe('layout', () => {
  it('places every star inside its constellation, reproducibly', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`k${i}`, i % 2 ? 'st' : 'dep'));
    const a = layout(cats, topics, items, 1000, 560);
    const b = layout(cats, topics, items, 1000, 560);
    expect(a.stars.size).toBe(12);
    expect([...a.stars.entries()]).toEqual([...b.stars.entries()]);
    expect(a.labels.map((l) => l.id)).toEqual(['eng', 'ops']);
    for (const p of a.stars.values()) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1000);
      expect(p.y).toBeLessThan(560);
    }
    // 每個主題 6 則 → 5 條星座線，兩個主題共 10 條
    expect(a.lines).toHaveLength(10);
  });
});

describe('這一年（D70）', () => {
  const tz = 'Asia/Taipei';
  const items = [
    item('a', 'st', { createdAt: T0 }),
    item('b', 'st', { createdAt: T0 + 1000 }),
    item('c', 'st', { createdAt: T0 - DAY }),
    item('d', 'st', { createdAt: T0 - 3 * DAY }),
  ];
  it('counts per local day', () => {
    const days = activityDays(items, tz);
    expect(days.find((d) => d.date === '2026-11-08')?.count).toBe(2);
    expect(days.find((d) => d.date === '2026-11-07')?.count).toBe(1);
  });
  it('year, streak and this week', () => {
    const s = yearStats(items, T0, tz);
    expect(s.year).toBe(4);
    expect(s.streak).toBe(2);
    expect(s.week).toBe(4);
  });
  it('monday to ISO week', () => {
    expect(isoWeekOfMonday('2026-11-02')).toBe('2026-W45');
    expect(isoWeekOfMonday('2025-12-29')).toBe('2026-W01');
  });
});
