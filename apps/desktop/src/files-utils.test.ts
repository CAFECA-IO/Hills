import { describe, expect, it } from 'vitest';
import type { FileEntry, FileSource } from './api';
import {
  DEFAULT_FILTER,
  badgeOf,
  expiryOf,
  filterFiles,
  isFiltered,
  scopeCounts,
  typeOf,
} from './files-utils';

const msg = (conv: string, author: string, excerpt = ''): FileSource => ({
  kind: 'message',
  convId: conv,
  messageId: 'm',
  author,
  at: 1,
  excerpt,
});

const file = (key: string, name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  key,
  kind: 'file',
  name,
  size: 1,
  mime: null,
  fileCount: null,
  sharedBy: 'me',
  sharedAt: 1,
  sources: [msg('c1', 'me')],
  downloaded: null,
  expiresAt: 0,
  attachment: null,
  ...extra,
});

describe('files-utils', () => {
  it('classifies by extension, mime and folder', () => {
    expect(typeOf(file('a', 'x.PDF'))).toBe('doc');
    expect(typeOf(file('a', 'x.xlsx'))).toBe('sheet');
    expect(typeOf(file('a', 'photo', { mime: 'image/heic' }))).toBe('image');
    expect(typeOf(file('a', 'd', { kind: 'folder' }))).toBe('folder');
    expect(typeOf(file('a', 'x.bin'))).toBe('other');
    expect(badgeOf(file('a', 'report.pptx'))).toBe('PPTX');
    expect(badgeOf(file('a', 'd', { kind: 'folder' }))).toBe('DIR');
  });

  it('filters by scope, source, type, conversation and text', () => {
    const files = [
      file('mine', 'a.pdf'),
      file('theirs', 'b.png', {
        sharedBy: 'x',
        sources: [msg('c2', 'x', '季報初稿')],
        downloaded: { path: '/p', at: 1 },
      }),
      file('kb', 'c.zip', {
        sharedBy: 'x',
        sources: [{ kind: 'kb', kbKey: 'k', title: '範本', author: 'x', at: 1 }],
      }),
    ];
    const keys = (f: Partial<typeof DEFAULT_FILTER>) =>
      filterFiles(files, { ...DEFAULT_FILTER, ...f }, 'me').map((x) => x.key);
    expect(keys({ scope: 'mine' })).toEqual(['mine']);
    expect(keys({ scope: 'others' })).toEqual(['theirs', 'kb']);
    expect(keys({ scope: 'downloaded' })).toEqual(['theirs']);
    expect(keys({ sources: ['kb'] })).toEqual(['kb']);
    expect(keys({ types: ['image', 'archive'] })).toEqual(['theirs', 'kb']);
    expect(keys({ conv: 'c2' })).toEqual(['theirs']);
    expect(keys({ query: '季報' })).toEqual(['theirs']);
    expect(keys({ query: '範本' })).toEqual(['kb']);
    expect(scopeCounts(files, 'me')).toEqual({ all: 3, mine: 1, others: 2, downloaded: 1 });
    // 其他篩選（例如只看某段對話）也套用到數字上，與清單一致
    const none = scopeCounts(files, 'me', { ...DEFAULT_FILTER, conv: 'no-such-conv' });
    expect(none).toEqual({ all: 0, mine: 0, others: 0, downloaded: 0 });
    expect(isFiltered(DEFAULT_FILTER)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTER, conv: 'c' })).toBe(true);
  });

  it('warns 30 days before storage expiry', () => {
    const day = 86_400_000;
    expect(expiryOf(100 * day, 0)).toEqual({ kind: 'ok' });
    expect(expiryOf(10 * day, 0)).toEqual({ kind: 'soon', days: 10 });
    expect(expiryOf(0, 1)).toEqual({ kind: 'expired' });
  });
});
