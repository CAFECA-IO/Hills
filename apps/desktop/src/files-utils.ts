/**
 * 「檔案」頁的純函式（ui-spec「檔案」v0.44，D64；technical-design §16.19）：
 * 類型分類、篩選、到期狀態。
 */
import type { FileEntry, FileSource } from './api';

export type FileType = 'doc' | 'image' | 'sheet' | 'slides' | 'folder' | 'archive' | 'other';
export const FILE_TYPES: FileType[] = [
  'doc',
  'image',
  'sheet',
  'slides',
  'folder',
  'archive',
  'other',
];

export type FileScope = 'all' | 'mine' | 'others' | 'downloaded';
export type SourceKind = FileSource['kind'];
export const SOURCE_KINDS: SourceKind[] = ['message', 'taskReport', 'kb'];

const EXT: Record<string, FileType> = {
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  md: 'doc',
  txt: 'doc',
  rtf: 'doc',
  pages: 'doc',
  odt: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  heic: 'image',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  numbers: 'sheet',
  ods: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  key: 'slides',
  odp: 'slides',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  tar: 'archive',
  dmg: 'archive',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function typeOf(f: Pick<FileEntry, 'kind' | 'name' | 'mime'>): FileType {
  if (f.kind === 'folder') return 'folder';
  const byExt = EXT[extOf(f.name)];
  if (byExt) return byExt;
  if (f.mime?.startsWith('image/')) return 'image';
  return 'other';
}

/** 圖示上的短標籤（PDF、PNG…；資料夾 DIR）。 */
export function badgeOf(f: Pick<FileEntry, 'kind' | 'name'>): string {
  if (f.kind === 'folder') return 'DIR';
  return (extOf(f.name) || 'FILE').slice(0, 4).toUpperCase();
}

export interface FileFilter {
  scope: FileScope;
  sources: SourceKind[];
  types: FileType[];
  sharer: string | null;
  conv: string | null;
  query: string;
}

export const DEFAULT_FILTER: FileFilter = {
  scope: 'all',
  sources: [],
  types: [],
  sharer: null,
  conv: null,
  query: '',
};

/** 搜尋與篩選；`sources` / `types` 空陣列 = 不限。 */
export function filterFiles(files: FileEntry[], f: FileFilter, me: string): FileEntry[] {
  const q = f.query.trim().toLowerCase();
  return files.filter((x) => {
    if (f.scope === 'mine' && x.sharedBy !== me) return false;
    if (f.scope === 'others' && x.sharedBy === me) return false;
    if (f.scope === 'downloaded' && !x.downloaded) return false;
    if (f.sources.length > 0 && !x.sources.some((s) => f.sources.includes(s.kind))) return false;
    if (f.types.length > 0 && !f.types.includes(typeOf(x))) return false;
    if (f.sharer && x.sharedBy !== f.sharer) return false;
    if (f.conv && !x.sources.some((s) => s.kind === 'message' && s.convId === f.conv)) return false;
    if (q) {
      const hay = [x.name, ...x.sources.map((s) => (s.kind === 'message' ? s.excerpt : s.title))]
        .join('\n')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 各範圍的數量（左欄）。 */
export function scopeCounts(files: FileEntry[], me: string): Record<FileScope, number> {
  return {
    all: files.length,
    mine: files.filter((x) => x.sharedBy === me).length,
    others: files.filter((x) => x.sharedBy !== me).length,
    downloaded: files.filter((x) => x.downloaded).length,
  };
}

export type Expiry = { kind: 'ok' } | { kind: 'soon'; days: number } | { kind: 'expired' };

/** 儲存節點上的保留期：30 天內到期顯示剩幾天。 */
export function expiryOf(expiresAt: number, now: number): Expiry {
  const left = expiresAt - now;
  if (left <= 0) return { kind: 'expired' };
  const days = Math.ceil(left / 86_400_000);
  return days <= 30 ? { kind: 'soon', days } : { kind: 'ok' };
}

/** 出處的作者。 */
export function authorOf(s: FileSource): string | null {
  return s.author;
}
