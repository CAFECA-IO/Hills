/** 知識庫「星空」的純函式（ui-spec「知識庫」、technical-design §16.11）。 */
import type { KbCategory, KbItem, KbTopic } from './api';
import { periodsAt } from './goals-utils';

export type RelationKind = 'ref' | 'topic' | 'task' | 'conv';

export interface Relation {
  key: string;
  kind: RelationKind;
}

/** 合併後仍存在的分類 / 主題（resolved === 自己）。 */
export function activeCategories(cats: KbCategory[]): KbCategory[] {
  return cats.filter((c) => c.resolved === c.id);
}

export function activeTopics(topics: KbTopic[]): KbTopic[] {
  return topics.filter((t) => t.resolved === t.id);
}

/** 知識所屬的最終主題與分類。 */
export function placeOf(
  item: KbItem,
  topics: KbTopic[],
): { topic: KbTopic | null; categoryId: string | null } {
  const raw = topics.find((t) => t.id === item.topicId);
  const topic = raw ? (topics.find((t) => t.id === raw.resolved) ?? raw) : null;
  return { topic, categoryId: topic?.categoryId ?? null };
}

/** 被引用次數（其他知識的 refs 指到它）。 */
export function citations(items: KbItem[]): Map<string, number> {
  const keys = new Set(items.map((i) => i.key));
  const out = new Map<string, number>();
  for (const i of items) {
    for (const r of new Set(i.refs)) {
      if (r !== i.key && keys.has(r)) out.set(r, (out.get(r) ?? 0) + 1);
    }
  }
  return out;
}

function sourceConv(i: KbItem): string | null {
  return i.source.kind === 'message' || i.source.kind === 'file' ? i.source.convId : null;
}

function sourceTask(i: KbItem): string | null {
  return i.source.kind === 'task' ? `${i.source.teamId}/${i.source.taskId}` : null;
}

/** 一則知識的四種關聯（每個對象只列一次，優先順序：引用 → 同任務 → 同對話 → 同主題）。 */
export function relations(item: KbItem, items: KbItem[], topics: KbTopic[]): Relation[] {
  const myTopic = placeOf(item, topics).topic?.id ?? null;
  const conv = sourceConv(item);
  const task = sourceTask(item);
  const out: Relation[] = [];
  for (const o of items) {
    if (o.key === item.key) continue;
    let kind: RelationKind | null = null;
    if (item.refs.includes(o.key) || o.refs.includes(item.key)) kind = 'ref';
    else if (task && sourceTask(o) === task) kind = 'task';
    else if (conv && sourceConv(o) === conv) kind = 'conv';
    else if (myTopic && placeOf(o, topics).topic?.id === myTopic) kind = 'topic';
    if (kind) out.push({ key: o.key, kind });
  }
  return out;
}

/** 組織時區的 ISO 週（`2026-W45`）。 */
export function weekOf(ms: number, tz: string): string {
  return periodsAt(ms, tz).week;
}

/** 每週新增數量：從最早一週到本週（最多 `max` 週，取最近的）。 */
export function weekly(
  items: KbItem[],
  now: number,
  tz: string,
  max = 16,
): { week: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const w = weekOf(i.createdAt, tz);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const weeks: string[] = [];
  const first = weekOf(items.length ? Math.min(...items.map((i) => i.createdAt)) : now, tz);
  for (let t = now; weeks.length < max; t -= 7 * 86_400_000) {
    const w = weekOf(t, tz);
    if (!weeks.includes(w)) weeks.unshift(w);
    if (w <= first) break;
  }
  return weeks.map((week) => ({ week, count: counts.get(week) ?? 0 }));
}

/** 只留下到某週為止建立的知識（`week` 為 null 時全部）。 */
export function upToWeek(items: KbItem[], week: string | null, tz: string): KbItem[] {
  if (!week) return items;
  return items.filter((i) => weekOf(i.createdAt, tz) <= week);
}

/** 搜尋標題、內容、標籤（不分大小寫）。 */
export function matches(item: KbItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [item.title, item.body, ...item.tags].some((s) => s.toLowerCase().includes(needle));
}

/** 摘要：內容去掉 Markdown 標記後的前 `n` 字。 */
export function summary(body: string, n = 80): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : plain;
}

// ── 星座版面 ─────────────────────────────────────────────────

/** FNV-1a 32 位元雜湊（版面用，可重現）。 */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface StarPos {
  x: number;
  y: number;
}

export interface Layout {
  stars: Map<string, StarPos>;
  labels: { id: string; name: string; x: number; y: number }[];
  /** 同主題的星座線（依建立時間串起） */
  lines: { from: string; to: string }[];
}

/**
 * 每個分類一個星座：分類依序排在畫布格位上，星星位置以 key 的雜湊決定（可重現），
 * 與已放置的星星保持最小距離。
 */
export function layout(
  categories: KbCategory[],
  topics: KbTopic[],
  items: KbItem[],
  w: number,
  h: number,
): Layout {
  const cats = activeCategories(categories);
  const n = Math.max(cats.length, 1);
  const cols = Math.max(1, Math.round(Math.sqrt((n * w) / h)));
  const rows = Math.ceil(n / cols);
  const cw = w / cols;
  const ch = h / rows;
  const stars = new Map<string, StarPos>();
  const labels: Layout['labels'] = [];
  const lines: Layout['lines'] = [];
  const byCat = new Map<string, KbItem[]>();
  for (const i of items) {
    const c = placeOf(i, topics).categoryId;
    if (c) byCat.set(c, [...(byCat.get(c) ?? []), i]);
  }
  cats.forEach((cat, ci) => {
    const ox = (ci % cols) * cw;
    const oy = Math.floor(ci / cols) * ch;
    labels.push({ id: cat.id, name: cat.name, x: ox + cw / 2, y: oy + 28 });
    const list = (byCat.get(cat.id) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const placed: StarPos[] = [];
    const minD = Math.min(cw, ch) / Math.max(4, Math.sqrt(list.length) * 2.2);
    for (const it of list) {
      let best: StarPos | null = null;
      let bestD = -1;
      for (let attempt = 0; attempt < 12; attempt++) {
        const hv = hash(`${it.key}#${attempt}`);
        const p = {
          x: ox + cw * (0.14 + 0.72 * ((hv & 0xffff) / 0xffff)),
          y: oy + 48 + (ch - 72) * (0.05 + 0.9 * ((hv >>> 16) / 0xffff)),
        };
        const d = placed.length
          ? Math.min(...placed.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))
          : Infinity;
        if (d >= minD) {
          best = p;
          break;
        }
        if (d > bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        placed.push(best);
        stars.set(it.key, best);
      }
    }
    // 同主題的知識依建立時間串成星座
    const byTopic = new Map<string, KbItem[]>();
    for (const it of list) {
      const t = placeOf(it, topics).topic?.id;
      if (t) byTopic.set(t, [...(byTopic.get(t) ?? []), it]);
    }
    for (const group of byTopic.values()) {
      for (let k = 1; k < group.length; k++) {
        lines.push({ from: group[k - 1]!.key, to: group[k]!.key });
      }
    }
  });
  return { stars, labels, lines };
}
