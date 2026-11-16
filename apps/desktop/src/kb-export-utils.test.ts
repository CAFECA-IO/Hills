// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { KbItem, KbSnapshot } from './api';
import {
  FORMAT,
  frontMatter,
  parseManifest,
  planExport,
  remapRefs,
  safeName,
  stripFrontMatter,
  uniquePath,
} from './kb-export-utils';

const item = (p: Partial<KbItem>): KbItem => ({
  key: 'm1:01',
  author: 'm1',
  title: '儀控訊號',
  body: '# 儀控\n\n內容',
  format: 'markdown',
  spec: null,
  tags: ['儀控'],
  topicId: 't1',
  refs: [],
  source: { kind: 'manual' },
  createdAt: Date.UTC(2026, 10, 1),
  updatedAt: Date.UTC(2026, 10, 2),
  updatedBy: 'm1',
  ...p,
});

const data: KbSnapshot = {
  categories: [
    { id: 'c1', name: '污水廠', resolved: 'c1', createdAt: 0 },
    { id: 'c2', name: '設計', resolved: 'c2', createdAt: 0 },
  ] as KbSnapshot['categories'],
  topics: [
    { id: 't1', categoryId: 'c1', name: '共用知識', resolved: 't1', createdAt: 0 },
    { id: 't2', categoryId: 'c2', name: '配色', resolved: 't2', createdAt: 0 },
  ] as KbSnapshot['topics'],
  items: [
    item({ refs: ['m1:02'] }),
    item({ key: 'm1:02', title: '儀控訊號' }),
    item({
      key: 'm1:03',
      title: 'A/B: 比較?',
      topicId: 't2',
      source: {
        kind: 'file',
        convId: 'x',
        attachment: { type: 'file', manifest: { name: '規格.pdf' }, fileKey: 'k' },
      },
    }),
  ],
};

describe('知識庫匯出 / 匯入（D74）', () => {
  it('路徑：安全化、重名加編號', () => {
    expect(safeName('A/B: 比較?')).toBe('A_B_ 比較_');
    expect(safeName('CON')).toBe('_CON');
    const used = new Set<string>();
    expect(uniquePath(used, 'x', '甲', '.md')).toBe('x/甲.md');
    expect(uniquePath(used, 'x', '甲', '.md')).toBe('x/甲-2.md');
  });

  it('front matter 往返', () => {
    const md =
      frontMatter({ title: '甲 "乙"', tags: ['a'], author: '王', created: 0, updated: 0 }) + '內文';
    expect(md).toContain('title: "甲 \\"乙\\""');
    expect(stripFrontMatter(md)).toBe('內文');
    expect(stripFrontMatter('沒有')).toBe('沒有');
  });

  it('整理匯出並解析回來', () => {
    const plan = planExport(data, {
      category: null,
      withAttachments: true,
      org: 'CAFECA',
      dir: 'Hills 知識庫',
      now: 1,
      nameOf: () => '王小明',
    });
    expect(plan.docs.map((d) => d.path)).toEqual([
      'Hills 知識庫/污水廠/共用知識/儀控訊號.md',
      'Hills 知識庫/污水廠/共用知識/儀控訊號-2.md',
      'Hills 知識庫/設計/配色/A_B_ 比較_.md',
    ]);
    expect(plan.attachments[0]!.path).toBe('Hills 知識庫/設計/配色/A_B_ 比較_.files/規格.pdf');
    expect(plan.docs[0]!.text).toMatch(/^---\ntitle: "儀控訊號"/);
    const m = parseManifest(JSON.stringify(plan.manifest))!;
    expect(m.format).toBe(FORMAT);
    expect(m.items[0]!.path).toBe('污水廠/共用知識/儀控訊號.md');
    expect(m.items[2]!.attachments).toEqual([
      { name: '規格.pdf', path: '設計/配色/A_B_ 比較_.files/規格.pdf' },
    ]);
    expect(m.categories.map((c) => c.name)).toEqual(['污水廠', '設計']);
    // 只匯出一個分類、不含附件
    const one = planExport(data, {
      category: 'c2',
      withAttachments: false,
      org: '',
      dir: 'd',
      now: 1,
      nameOf: () => '',
    });
    expect(one.manifest.items.length).toBe(1);
    expect(one.attachments).toEqual([]);
    expect(one.manifest.topics.map((x) => x.id)).toEqual(['t2']);
  });

  it('拒絕不安全的 manifest；重建引用', () => {
    expect(parseManifest('{')).toBeNull();
    expect(
      parseManifest(JSON.stringify({ format: 'x', items: [], topics: [], categories: [] })),
    ).toBeNull();
    const bad = {
      format: FORMAT,
      items: [{ key: 'a', path: '../x.md', title: 't', tags: [], refs: [], attachments: [] }],
      topics: [],
      categories: [],
    };
    expect(parseManifest(JSON.stringify(bad))).toBeNull();
    expect(remapRefs(['a', 'b'], new Map([['a', 'A']]))).toEqual(['A']);
  });
});
