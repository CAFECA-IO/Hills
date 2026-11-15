/**
 * 文件理解（D68，technical-design §16.20、ui-spec v0.49）的純函式：哪些檔案要建立索引、內容命中如何併入檔案清單。
 */
import type { DocAiStatus, DocFileState, DocHit, FileEntry } from './api';
import { extOf } from './files-utils';

/** 單檔上限（與 Rust 端相同） */
export const MAX_BYTES = 50 * 1024 * 1024;

export function isPdf(f: Pick<FileEntry, 'kind' | 'name' | 'mime'>): boolean {
  return f.kind === 'file' && (f.mime === 'application/pdf' || extOf(f.name) === 'pdf');
}

/** 知識附件中可轉文字索引的 HTML / Markdown（technical-design §16.20 v0.42）。 */
export function isKbText(f: Pick<FileEntry, 'kind' | 'name'>): boolean {
  return f.kind === 'file' && ['html', 'htm', 'md', 'markdown'].includes(extOf(f.name));
}

/**
 * 自動排入的檔案：還沒有索引狀態的 PDF；知識庫的檔案一律排入，
 * 結案報告與對話的檔案在本機下載後才排入（其餘由使用者按「建立索引」）。
 */
export function autoQueue(files: FileEntry[], status: DocAiStatus): FileEntry[] {
  if (!status.ready) return [];
  return files.filter(
    (f) =>
      !status.files[f.key] &&
      ((isPdf(f) && (f.downloaded !== null || f.sources.some((s) => s.kind === 'kb'))) ||
        // v0.42（D71）：知識的 HTML / Markdown 附件也建立索引
        (isKbText(f) && f.sources.some((s) => s.kind === 'kb'))),
  );
}

/** 已經看不到（不在「檔案」清單）的檔案：刪除它的索引。 */
export function staleKeys(files: FileEntry[], status: DocAiStatus): string[] {
  if (!status.ready) return [];
  const keys = new Set(files.map((f) => f.key));
  return Object.keys(status.files).filter((k) => !keys.has(k));
}

export type IndexState =
  { kind: 'none' } | { kind: 'queued' } | { kind: 'running' } | ({ kind: 'done' } & DocFileState);

export function indexStateOf(
  key: string,
  status: DocAiStatus | null,
  running: string | null,
  queued: readonly string[],
): IndexState {
  if (running === key) return { kind: 'running' };
  if (queued.includes(key)) return { kind: 'queued' };
  const s = status?.files[key];
  return s ? { kind: 'done', ...s } : { kind: 'none' };
}

/**
 * 檔案搜尋併入內容命中（ui-spec v0.49）：檔名或出處符合的排前面；
 * 只有內容符合的檔案（須通過其他篩選，即在 `candidates` 中）依相似度接在後面。
 */
export function mergeContentHits(
  nameMatches: FileEntry[],
  candidates: FileEntry[],
  hits: DocHit[],
): { list: FileEntry[]; hits: Record<string, DocHit[]> } {
  const byKey: Record<string, DocHit[]> = {};
  for (const h of [...hits].sort((a, b) => b.score - a.score)) {
    (byKey[h.fileKey] ??= []).push(h);
  }
  const named = new Set(nameMatches.map((f) => f.key));
  const extra = candidates
    .filter((f) => !named.has(f.key) && byKey[f.key])
    .sort((a, b) => byKey[b.key]![0]!.score - byKey[a.key]![0]!.score);
  return { list: [...nameMatches, ...extra], hits: byKey };
}

/** 片段：找得到關鍵字時取前後各 `radius` 字，否則取開頭。 */
export function snippetAround(text: string, query: string, radius = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const q = query.trim().toLowerCase();
  const i = q ? flat.toLowerCase().indexOf(q) : -1;
  if (i < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  const from = Math.max(0, i - radius);
  const to = Math.min(flat.length, i + q.length + radius);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/** 元件下載的整體進度（0–100）。 */
export function downloadPercent(status: DocAiStatus): number {
  const total = status.components.reduce((n, c) => n + c.size, 0);
  if (total === 0) return 0;
  const done = status.components.reduce(
    (n, c) => n + (c.state === 'ready' ? c.size : Math.min(c.done, c.size)),
    0,
  );
  return Math.round((done / total) * 100);
}
