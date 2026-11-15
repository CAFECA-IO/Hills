// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { FolderPickEntry, KbItem } from './api';
import {
  byteLength,
  htmlToMarkdown,
  importedBy,
  missingFrom,
  pickImportable,
  sha256Hex,
  statusOf,
  titleFor,
  topicOf,
  truncateBody,
} from './kb-import-utils';

const file = (path: string, size = 10): FolderPickEntry => ({
  kind: 'file',
  path,
  token: path,
  size,
  mtime: null,
});

const imported = (path: string, sha256: string, author = 'me'): KbItem => ({
  key: `${author}:${path}`,
  author,
  title: path,
  body: '',
  format: 'markdown',
  spec: null,
  tags: [],
  topicId: 't',
  refs: [],
  source: { kind: 'import', root: '06', path, sha256 },
  createdAt: 0,
  updatedAt: 0,
  updatedBy: author,
});

describe('匯入資料夾（D71）', () => {
  it('篩選副檔名、略過隱藏檔、主題取第一層', () => {
    const r = pickImportable([
      { kind: 'dir', path: '01_共用' },
      file('index.html'),
      file('01_共用/資料標準/特徵.html'),
      file('04_工具/需求.MD'),
      file('04_工具/表.xlsx'),
      file('assets/style.css'),
      file('.DS_Store'),
      file('02/.hidden/a.md'),
      file('05/規格.pdf'),
    ]);
    expect(r.files.map((f) => f.path)).toEqual([
      '01_共用/資料標準/特徵.html',
      '04_工具/需求.MD',
      '05/規格.pdf',
      'index.html',
    ]);
    expect(r.files.map((f) => f.kind)).toEqual(['html', 'md', 'pdf', 'html']);
    expect(r.skipped).toBe(2);
    expect(topicOf('index.html')).toBe('一般');
    expect(topicOf('01_共用/資料標準/特徵.html')).toBe('01_共用');
  });

  it('比對：新增、更新、沒有變更；只看本人同一資料夾', () => {
    const items = [imported('a.html', 'x'), imported('b.html', 'y', 'other')];
    const map = importedBy(items, 'me', '06');
    expect(statusOf(map, 'a.html', 'x')).toBe('same');
    expect(statusOf(map, 'a.html', 'z')).toBe('changed');
    expect(statusOf(map, 'b.html', 'y')).toBe('new');
    expect(missingFrom(map, []).map((i) => i.title)).toEqual(['a.html']);
    expect(importedBy(items, 'me', '07').size).toBe(0);
  });

  it('HTML 轉 Markdown：標題、清單、表格、連結，去掉腳本', () => {
    const { title, markdown } = htmlToMarkdown(`<!doctype html><html><head><title>儀控訊號</title>
      <style>.x{}</style><script>alert(1)</script></head><body>
      <nav><a href="index.html">首頁</a></nav>
      <h1>儀控訊號</h1><p>每 <strong>5 分鐘</strong> 一筆，見 <a href="https://example.com">說明</a>。</p>
      <ul><li>流量</li><li>溶氧<ul><li>DO1</li></ul></li></ul>
      <table><tr><th>代碼</th><th>名稱</th></tr><tr><td>FIT-01</td><td>進流|流量</td></tr></table>
      <div><section><h2>附註</h2><p>第一行<br>第二行</p></section></div></body></html>`);
    expect(title).toBe('儀控訊號');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('首頁');
    expect(markdown).toContain('# 儀控訊號');
    expect(markdown).toContain('每 **5 分鐘** 一筆，見 [說明](https://example.com)。');
    expect(markdown).toContain('- 流量\n- 溶氧\n  - DO1');
    expect(markdown).toContain('| 代碼 | 名稱 |\n| --- | --- |\n| FIT-01 | 進流\\|流量 |');
    expect(markdown).toContain('## 附註');
    expect(markdown).toContain('第一行\n第二行');
  });

  it('超過上限時在段落邊界截斷並加註', () => {
    const md = Array.from({ length: 50 }, (_, i) => `第 ${i} 段`.repeat(50)).join('\n\n');
    const r = truncateBody(md, '> 節錄', 4000);
    expect(r.truncated).toBe(true);
    expect(byteLength(r.body)).toBeLessThanOrEqual(4000);
    expect(r.body.endsWith('> 節錄')).toBe(true);
    expect(truncateBody('短', '> 節錄').truncated).toBe(false);
    expect(titleFor('01/規格.html', null)).toBe('規格');
  });

  it('SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
