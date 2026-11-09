// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  cleanCss,
  htmlSections,
  markdownSections,
  missingRequired,
  sanitizeHtml,
  splitHeading,
  summaryOf,
  templateFor,
} from './doc-spec';

describe('hills-doc/1 Markdown', () => {
  it('依 H2 與 {#key} 分段，略過程式碼區塊，自訂段落沒有 key', () => {
    const md =
      '前言\n\n## 摘要 {#summary}\n**重點**在這\n\n## 內容 {#content}\n```\n## 假標題\n```\n內文\n\n## 我的段落\n自訂\n\n## 圖 {#x-chart}\n圖';
    const s = markdownSections(md);
    expect(s.map((x) => x.key)).toEqual(['lead', 'summary', 'content', null, 'x-chart']);
    expect(s[1]?.text).toBe('重點在這');
    expect(s[2]?.text).toContain('假標題');
    expect(missingRequired('knowledge', s)).toEqual([]);
  });

  it('必填段落空白時視為缺少；報告有完成條件時需要 criteria', () => {
    const s = markdownSections('## 摘要 {#summary}\n\n## 內容 {#content}\n有');
    expect(missingRequired('knowledge', s)).toEqual(['summary']);
    const r = markdownSections('## 結果摘要 {#summary}\n完成');
    expect(missingRequired('report', r)).toEqual([]);
    expect(missingRequired('report', r, true)).toEqual(['criteria']);
  });

  it('標題 key 只接受小寫英數與 -', () => {
    expect(splitHeading('摘要 {#summary}')).toEqual(['摘要', 'summary']);
    expect(splitHeading('A {#Bad Key}')).toEqual(['A {#Bad Key}', null]);
  });

  it('範本本身符合規格（摘要與內容有提示文字）', () => {
    expect(
      missingRequired('knowledge', markdownSections(templateFor('knowledge', 'markdown'))),
    ).toEqual([]);
    expect(missingRequired('knowledge', htmlSections(templateFor('knowledge', 'html')))).toEqual(
      [],
    );
  });
});

describe('hills-doc/1 HTML', () => {
  const html =
    '<article data-hills-doc="1"><style>.a{color:red;background:url(https://evil/x.png)}@import "https://x";</style>' +
    '<section data-section="summary"><h2>摘要</h2><p onclick="alert(1)">共 31 項</p></section>' +
    '<section data-section="x-chart" class="a" style="background:url(http://x)"><h2>圖</h2><p>A</p></section>' +
    '<script>alert(1)</script><iframe src="https://x"></iframe><img src="https://x/a.png"><a href="javascript:alert(1)">x</a></article>';

  it('清理：移除腳本、事件、iframe、外部資源，保留結構與樣式', () => {
    const out = sanitizeHtml(html);
    expect(out).not.toMatch(
      /<script|onclick|<iframe|javascript:|https:\/\/evil|@import|https:\/\/x\/a\.png/,
    );
    expect(out).toContain('data-section="summary"');
    expect(out).toContain('<style>');
    expect(out).toContain('class="a"');
  });

  it('段落與摘要', () => {
    const s = htmlSections(html);
    expect(s.map((x) => x.key)).toEqual(['summary', 'x-chart']);
    expect(s[0]?.title).toBe('摘要');
    expect(s[0]?.text).toBe('共 31 項');
    expect(summaryOf('html', html)).toBe('共 31 項');
  });

  it('CSS 只保留 data: 的 url()', () => {
    expect(cleanCss('a{background:url("data:image/png;base64,AA")}')).toContain('data:image');
    expect(cleanCss('a{background:url(http://x)}')).toBe('a{background:none}');
  });
});
