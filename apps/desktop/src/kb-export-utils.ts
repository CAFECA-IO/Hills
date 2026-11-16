/**
 * 知識庫匯出 / 匯入的純函式（technical-design §16.23、ui-spec「知識庫 › 匯出 / 匯入」v0.55，D74）：
 * 格式 `hills-kb/1` 的 manifest、路徑、front matter 與引用對照。
 */
import type { KbCategory, KbItem, KbSnapshot, KbTopic } from './api';
import { htmlToMarkdown } from './kb-import-utils';

export const MANIFEST = 'hills-kb.json';
export const FORMAT = 'hills-kb/1';

export interface ManifestItem {
  key: string;
  /** `.md` 的相對路徑 */
  path: string;
  title: string;
  topicId: string;
  tags: string[];
  refs: string[];
  author: string;
  authorName: string;
  createdAt: number;
  updatedAt: number;
  attachments: { name: string; path: string }[];
}

export interface Manifest {
  format: typeof FORMAT;
  exportedAt: number;
  org: string;
  categories: { id: string; name: string }[];
  topics: { id: string; categoryId: string; name: string }[];
  items: ManifestItem[];
}

// ── 路徑 ─────────────────────────────────────────

const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 一段路徑元件（與 Rust `files::safe_component` 相同規則）。 */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.normalize('NFC').replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_');
  if (s.endsWith(' ') || s.endsWith('.')) s = `_${s}`;
  if (RESERVED.has((s.split('.')[0] ?? '').toUpperCase())) s = `_${s}`;
  if (!s || s === '.' || s === '..') s = '_';
  return s;
}

/** 在 `used` 中找不重複的路徑（`名稱.md`、`名稱-2.md`…），並登記。比對不分大小寫。 */
export function uniquePath(used: Set<string>, dir: string, base: string, ext: string): string {
  const name = safeName(base).slice(0, 120);
  for (let n = 1; ; n++) {
    const p = `${dir}/${n === 1 ? name : `${name}-${n}`}${ext}`;
    if (!used.has(p.toLowerCase())) {
      used.add(p.toLowerCase());
      return p;
    }
  }
}

// ── front matter ─────────────────────────────────────

const quote = (s: string) => JSON.stringify(s);

export function frontMatter(m: {
  title: string;
  tags: string[];
  author: string;
  created: number;
  updated: number;
}): string {
  return [
    '---',
    `title: ${quote(m.title)}`,
    `tags: [${m.tags.map(quote).join(', ')}]`,
    `author: ${quote(m.author)}`,
    `created: ${new Date(m.created).toISOString()}`,
    `updated: ${new Date(m.updated).toISOString()}`,
    '---',
    '',
  ].join('\n');
}

/** 去掉開頭的 front matter（`---` … `---`）。 */
export function stripFrontMatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return (m ? md.slice(m[0].length) : md).replace(/^\s*\n/, '');
}

// ── 匯出 ─────────────────────────────────────────

const finalOf = <T extends { id: string; resolved: string }>(all: T[], id: string) => {
  const x = all.find((a) => a.id === id);
  return x ? (all.find((a) => a.id === x.resolved) ?? x) : undefined;
};

export interface ExportPlan {
  manifest: Manifest;
  /** 要寫出的 Markdown：路徑與內容 */
  docs: { path: string; text: string; item: KbItem }[];
  /** 要寫出的附件：路徑與附件 JSON（解密在畫面端做） */
  attachments: { path: string; attachment: unknown; item: KbItem }[];
}

/** 這則知識的原附件（檔案或匯入來源）。 */
export function attachmentOf(i: KbItem): unknown {
  if (i.source.kind === 'file') return i.source.attachment;
  if (i.source.kind === 'import') return i.source.attachment ?? null;
  return null;
}

/** 單一檔案附件的檔名（`{ type: 'file', manifest: { name } }`；資料夾附件不匯出）。 */
export function attachmentName(att: unknown): string | null {
  if (!att || typeof att !== 'object') return null;
  const a = att as { type?: unknown; manifest?: { name?: unknown } };
  return a.type === 'file' && typeof a.manifest?.name === 'string' ? a.manifest.name : null;
}

/** 整理要匯出的內容。`category` = 只匯出這個分類（最終項目 id）；`dir` = 匯出資料夾名稱。 */
export function planExport(
  data: KbSnapshot,
  opts: {
    category: string | null;
    withAttachments: boolean;
    org: string;
    dir: string;
    now: number;
    nameOf: (id: string) => string;
  },
): ExportPlan {
  const cats = data.categories.filter((c) => c.resolved === c.id);
  const topics = data.topics.filter((x) => x.resolved === x.id);
  const used = new Set<string>();
  const docs: ExportPlan['docs'] = [];
  const attachments: ExportPlan['attachments'] = [];
  const items: ManifestItem[] = [];
  const catOfTopic = (tp: KbTopic) => finalOf<KbCategory>(data.categories, tp.categoryId);
  for (const it of data.items) {
    const tp = finalOf<KbTopic>(data.topics, it.topicId);
    const cat = tp && catOfTopic(tp);
    if (!tp || !cat) continue;
    if (opts.category && cat.id !== opts.category) continue;
    const folder = `${opts.dir}/${safeName(cat.name)}/${safeName(tp.name)}`;
    const path = uniquePath(used, folder, it.title || it.key, '.md');
    const body = it.format === 'html' ? htmlToMarkdown(it.body).markdown : it.body;
    const author = opts.nameOf(it.author);
    const text =
      frontMatter({
        title: it.title,
        tags: it.tags,
        author,
        created: it.createdAt,
        updated: it.updatedAt,
      }) +
      body.trim() +
      '\n';
    docs.push({ path, text, item: it });
    const atts: ManifestItem['attachments'] = [];
    const att = opts.withAttachments ? attachmentOf(it) : null;
    const name = attachmentName(att);
    if (att && name) {
      const ap = uniquePath(
        used,
        path.replace(/\.md$/, '.files'),
        name.replace(/\.[^.]+$/, ''),
        name.match(/\.[^.]+$/)?.[0] ?? '',
      );
      attachments.push({ path: ap, attachment: att, item: it });
      atts.push({ name, path: rel(opts.dir, ap) });
    }
    items.push({
      key: it.key,
      path: rel(opts.dir, path),
      title: it.title,
      topicId: tp.id,
      tags: it.tags,
      refs: it.refs,
      author: it.author,
      authorName: author,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      attachments: atts,
    });
  }
  const usedTopics = new Set(items.map((i) => i.topicId));
  const outTopics = topics.filter((x) => usedTopics.has(x.id));
  const usedCats = new Set(outTopics.map((x) => catOfTopic(x)?.id));
  return {
    manifest: {
      format: FORMAT,
      exportedAt: opts.now,
      org: opts.org,
      categories: cats.filter((c) => usedCats.has(c.id)).map((c) => ({ id: c.id, name: c.name })),
      topics: outTopics.map((x) => ({
        id: x.id,
        categoryId: catOfTopic(x)?.id ?? x.categoryId,
        name: x.name,
      })),
      items,
    },
    docs,
    attachments,
  };
}

const rel = (dir: string, p: string) => p.slice(dir.length + 1);

// ── 匯入 ─────────────────────────────────────────

/** 解析並驗證 manifest；格式不符時回傳 null。 */
export function parseManifest(text: string): Manifest | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const m = v as Partial<Manifest>;
  if (m.format !== FORMAT || !Array.isArray(m.items) || !Array.isArray(m.topics)) return null;
  if (!Array.isArray(m.categories)) return null;
  const okPath = (p: unknown) =>
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 500 &&
    !p.startsWith('/') &&
    !p.split('/').some((s) => s === '..' || s === '');
  for (const i of m.items) {
    if (!i || typeof i.key !== 'string' || !okPath(i.path) || typeof i.title !== 'string')
      return null;
    if (!Array.isArray(i.tags) || !Array.isArray(i.refs) || !Array.isArray(i.attachments))
      return null;
    if (i.attachments.some((a) => !a || !okPath(a.path))) return null;
  }
  return {
    format: FORMAT,
    exportedAt: Number(m.exportedAt) || 0,
    org: typeof m.org === 'string' ? m.org : '',
    categories: m.categories,
    topics: m.topics,
    items: m.items,
  };
}

/** 舊 key → 新 key 重建引用（找不到的引用略過）。 */
export function remapRefs(refs: string[], keys: Map<string, string>): string[] {
  return refs.map((r) => keys.get(r)).filter((r): r is string => !!r);
}
