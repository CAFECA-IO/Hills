import { describe, expect, it } from 'vitest';
import type { DocAiStatus, DocHit, FileEntry, FileSource } from './api';
import {
  autoQueue,
  downloadPercent,
  indexStateOf,
  isPdf,
  mergeContentHits,
  snippetAround,
  staleKeys,
} from './docai-utils';

const kb: FileSource = { kind: 'kb', kbKey: 'k', title: 'T', author: 'a', at: 1 };
const msg: FileSource = {
  kind: 'message',
  convId: 'c',
  messageId: 'm',
  author: 'a',
  at: 1,
  excerpt: '',
};

const file = (key: string, p: Partial<FileEntry> = {}): FileEntry => ({
  key,
  kind: 'file',
  name: `${key}.pdf`,
  size: 1000,
  mime: null,
  fileCount: null,
  sharedBy: 'a',
  sharedAt: 1,
  sources: [msg],
  downloaded: null,
  expiresAt: 0,
  attachment: null,
  ...p,
});

const status = (p: Partial<DocAiStatus> = {}): DocAiStatus => ({
  supported: true,
  enabled: true,
  model: 'e5-small',
  ready: true,
  components: [],
  files: {},
  totalChunks: 0,
  kbItems: 0,
  ...p,
});

const hit = (fileKey: string, score: number): DocHit => ({
  fileKey,
  name: fileKey,
  pageFrom: 1,
  pageTo: 1,
  heading: [],
  snippet: '',
  score,
});

describe('isPdf', () => {
  it('uses mime or extension, never folders', () => {
    expect(isPdf({ kind: 'file', name: 'a.PDF', mime: null })).toBe(true);
    expect(isPdf({ kind: 'file', name: 'a', mime: 'application/pdf' })).toBe(true);
    expect(isPdf({ kind: 'file', name: 'a.docx', mime: null })).toBe(false);
    expect(isPdf({ kind: 'folder', name: 'x.pdf', mime: null })).toBe(false);
  });
});

describe('autoQueue', () => {
  it('queues knowledge PDFs and downloaded ones without a state', () => {
    const files = [
      file('kb', { sources: [kb] }),
      file('chat'),
      file('dl', { downloaded: { path: '/x', at: 1 } }),
      file('done', { sources: [kb] }),
      file('doc', { name: 'a.docx', sources: [kb] }),
    ];
    const s = status({
      files: { done: { name: 'd', chunks: 2, at: 1, status: 'ready', reason: null } },
    });
    expect(autoQueue(files, s).map((f) => f.key)).toEqual(['kb', 'dl']);
    expect(autoQueue(files, status({ ready: false }))).toEqual([]);
  });

  it('finds indexes of files no longer visible', () => {
    const s = status({
      files: {
        a: { name: 'a', chunks: 1, at: 1, status: 'ready', reason: null },
        gone: { name: 'g', chunks: 1, at: 1, status: 'failed', reason: 'unreadable' },
      },
    });
    expect(staleKeys([file('a')], s)).toEqual(['gone']);
  });
});

describe('indexStateOf', () => {
  it('prefers running, then queued, then stored state', () => {
    const s = status({
      files: { a: { name: 'a', chunks: 3, at: 1, status: 'ready', reason: null } },
    });
    expect(indexStateOf('a', s, 'a', []).kind).toBe('running');
    expect(indexStateOf('a', s, null, ['a']).kind).toBe('queued');
    expect(indexStateOf('a', s, null, [])).toMatchObject({ kind: 'done', chunks: 3 });
    expect(indexStateOf('b', s, null, []).kind).toBe('none');
  });
});

describe('mergeContentHits', () => {
  it('appends content-only matches after name matches by score', () => {
    const a = file('a');
    const b = file('b');
    const c = file('c');
    const out = mergeContentHits([a], [a, b, c], [hit('c', 0.9), hit('b', 0.7), hit('a', 0.8)]);
    expect(out.list.map((f) => f.key)).toEqual(['a', 'c', 'b']);
    expect(out.hits.a).toHaveLength(1);
  });
  it('skips hits outside the other filters', () => {
    const out = mergeContentHits([], [file('a')], [hit('z', 0.9)]);
    expect(out.list).toEqual([]);
  });
});

describe('snippetAround', () => {
  it('centres on the query when present', () => {
    const text = `${'甲'.repeat(60)}請假規則${'乙'.repeat(60)}`;
    const s = snippetAround(text, '請假', 5);
    expect(s).toBe(`…甲甲甲甲甲請假規則乙乙乙…`);
  });
  it('falls back to the beginning', () => {
    expect(snippetAround('短短的', '不存在')).toBe('短短的');
    expect(snippetAround('a'.repeat(100), 'zz', 10)).toBe(`${'a'.repeat(20)}…`);
  });
});

describe('downloadPercent', () => {
  it('weights by size and counts ready components fully', () => {
    const s = status({
      components: [
        { id: 'pdfium', size: 100, state: 'ready', done: 0, total: 100, error: null },
        { id: 'e5', size: 300, state: 'downloading', done: 100, total: 300, error: null },
      ],
    });
    expect(downloadPercent(s)).toBe(50);
  });
});
