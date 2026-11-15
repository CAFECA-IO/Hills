/**
 * 知識庫匯入資料夾的純函式（ui-spec「知識庫 › 匯入資料夾」v0.52、technical-design §16.22，D71）：
 * 篩選檔案、決定主題、比對既有知識、HTML 轉 Markdown、截斷。
 */
import type { FolderPickEntry, KbItem } from './api';

/** 一次最多匯入的檔案數。 */
export const MAX_IMPORT_FILES = 500;
/** 知識內文上限（與 hills-node 相同，UTF-8 位元組）。 */
export const MAX_BODY_BYTES = 64 * 1024;
/** 根目錄檔案的主題名稱。 */
export const ROOT_TOPIC = '一般';

export type ImportKind = 'md' | 'html' | 'pdf';

export interface ImportFile {
  path: string;
  token: string;
  size: number;
  mtime: number | null;
  kind: ImportKind;
  /** 主題名稱（第一層子資料夾，根目錄為「一般」） */
  topic: string;
}

const KIND: Record<string, ImportKind> = {
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
};

export function kindOf(path: string): ImportKind | null {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return KIND[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function topicOf(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts[0]! : ROOT_TOPIC;
}

/** 可匯入的檔案（略過隱藏檔與隱藏資料夾）與略過的其他檔案數。 */
export function pickImportable(entries: FolderPickEntry[]): {
  files: ImportFile[];
  skipped: number;
  overLimit: number;
} {
  const files: ImportFile[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const hidden = e.path.split('/').some((p) => p.startsWith('.'));
    const kind = kindOf(e.path);
    if (hidden || !kind) {
      if (!hidden) skipped++;
      continue;
    }
    files.push({
      path: e.path,
      token: e.token,
      size: e.size,
      mtime: e.mtime,
      kind,
      topic: topicOf(e.path),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: files.slice(0, MAX_IMPORT_FILES),
    skipped,
    overLimit: Math.max(0, files.length - MAX_IMPORT_FILES),
  };
}

export type ImportStatus = 'new' | 'changed' | 'same';

/** 本人先前從同一個資料夾匯入的知識：相對路徑 → 知識。 */
export function importedBy(items: KbItem[], me: string, root: string): Map<string, KbItem> {
  const map = new Map<string, KbItem>();
  for (const i of items) {
    if (i.author === me && i.source.kind === 'import' && i.source.root === root)
      map.set(i.source.path, i);
  }
  return map;
}

export function statusOf(
  existing: Map<string, KbItem>,
  path: string,
  sha256: string | null,
): ImportStatus {
  const e = existing.get(path);
  if (!e || e.source.kind !== 'import') return 'new';
  if (sha256 === null) return 'changed';
  return e.source.sha256 === sha256 ? 'same' : 'changed';
}

/** 資料夾中已不存在的匯入知識。 */
export function missingFrom(existing: Map<string, KbItem>, files: ImportFile[]): KbItem[] {
  const paths = new Set(files.map((f) => f.path));
  return [...existing.entries()].filter(([p]) => !paths.has(p)).map(([, i]) => i);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── HTML → Markdown ─────────────────────────────────────

const SKIP = new Set(['script', 'style', 'nav', 'noscript', 'svg', 'canvas', 'template', 'iframe']);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'blockquote',
]);

const squash = (s: string) => s.replace(/\s+/g, ' ');
const cell = (s: string) => squash(s).trim().replace(/\|/g, '\\|');

function inline(node: Node): string {
  if (node.nodeType === 3) return squash(node.textContent ?? '');
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  const inner = () => [...el.childNodes].map(inline).join('');
  switch (tag) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b': {
      const t = inner().trim();
      return t ? `**${t}**` : '';
    }
    case 'em':
    case 'i': {
      const t = inner().trim();
      return t ? `*${t}*` : '';
    }
    case 'code':
      return `\`${(el.textContent ?? '').replace(/`/g, '')}\``;
    case 'a': {
      const t = inner().trim();
      const href = el.getAttribute('href') ?? '';
      return /^https?:\/\//i.test(href) && t ? `[${t}](${href})` : t;
    }
    case 'img':
      return el.getAttribute('alt') ?? '';
    default:
      return inner();
  }
}

function table(el: Element): string {
  const rows = [...el.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th,td')].map((c) => cell(inline(c))),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
  const head = pad(rows[0]!);
  const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

function blocks(node: Node, out: string[], list: { depth: number; ordered: boolean[] }) {
  if (node.nodeType === 3) {
    const t = squash(node.textContent ?? '').trim();
    if (t) out.push(t);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return;
  if (/^h[1-6]$/.test(tag)) {
    const t = inline(el).trim();
    if (t) out.push(`${'#'.repeat(Number(tag[1]))} ${t}`);
    return;
  }
  if (tag === 'table') {
    const t = table(el);
    if (t) out.push(t);
    return;
  }
  if (tag === 'pre') {
    out.push(`\`\`\`\n${(el.textContent ?? '').replace(/\n+$/, '')}\n\`\`\``);
    return;
  }
  if (tag === 'hr') {
    out.push('---');
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    let n = 0;
    for (const li of el.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      n++;
      const nested = [...li.children].filter((c) => /^(ul|ol)$/i.test(c.tagName));
      const own = [...li.childNodes]
        .filter((c) => !nested.includes(c as Element))
        .map(inline)
        .join('')
        .trim();
      const indent = '  '.repeat(list.depth);
      if (own) out.push(`${indent}${ordered ? `${n}.` : '-'} ${own}`);
      for (const sub of nested) blocks(sub, out, { depth: list.depth + 1, ordered: [] });
    }
    return;
  }
  // 只含行內內容的區塊 → 一段；含區塊子元素 → 遞迴
  const hasBlock = [...el.children].some((c) => {
    const ct = c.tagName.toLowerCase();
    return BLOCK.has(ct) || /^h[1-6]$/.test(ct) || ['ul', 'ol', 'table', 'pre', 'hr'].includes(ct);
  });
  if (!hasBlock && (BLOCK.has(tag) || tag === 'li' || tag === 'body')) {
    const t = inline(el)
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim();
    if (t) out.push(tag === 'blockquote' ? `> ${t.replace(/\n/g, '\n> ')}` : t);
    return;
  }
  for (const c of el.childNodes) blocks(c, out, list);
}

/** HTML 文件 → Markdown 與標題（`<title>`、第一個 h1，都沒有時為 null）。 */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title =
    doc.querySelector('title')?.textContent?.trim() ||
    doc.querySelector('h1')?.textContent?.trim() ||
    null;
  const out: string[] = [];
  if (doc.body) blocks(doc.body, out, { depth: 0, ordered: [] });
  // 合併相鄰的清單項目，其他區塊之間空一行
  const md: string[] = [];
  for (const b of out) {
    const isItem = /^\s*(-|\d+\.) /.test(b);
    const prevItem = md.length > 0 && /^\s*(-|\d+\.) /.test(md[md.length - 1]!.split('\n').pop()!);
    if (isItem && prevItem) md[md.length - 1] += `\n${b}`;
    else md.push(b);
  }
  return { title, markdown: md.join('\n\n').trim() };
}

/** Markdown 的標題：第一個 `# ` 行。 */
export function markdownTitle(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1]!.trim() : null;
}

const enc = new TextEncoder();
export const byteLength = (s: string) => enc.encode(s).length;

/** 超過上限時在段落邊界截斷並加上說明；回傳是否截斷。 */
export function truncateBody(
  md: string,
  note: string,
  limit = MAX_BODY_BYTES,
): { body: string; truncated: boolean } {
  if (byteLength(md) <= limit) return { body: md, truncated: false };
  const budget = limit - byteLength(note) - 8;
  const parts = md.split('\n\n');
  const kept: string[] = [];
  let used = 0;
  for (const p of parts) {
    const n = byteLength(p) + 2;
    if (used + n > budget) break;
    kept.push(p);
    used += n;
  }
  if (kept.length === 0) {
    // 第一段就太長：以字元截斷
    let s = '';
    for (const ch of md) {
      if (byteLength(s + ch) > budget) break;
      s += ch;
    }
    kept.push(s);
  }
  return { body: `${kept.join('\n\n')}\n\n${note}`, truncated: true };
}

/** 標題：轉換結果的標題，沒有時為檔名（去副檔名），最多 200 字。 */
export function titleFor(path: string, found: string | null): string {
  const name = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  return [...(found?.trim() || name)].slice(0, 200).join('');
}
