/**
 * 文件規格 hills-doc/1（technical-design §16.16，D52）：段落解析、必填檢查、範本與 HTML 清理。
 * Rust 端（hills_node::doc_spec）在寫入時再檢查一次。
 */
import DOMPurify from 'dompurify';
import { t } from './i18n';

export const SPEC_V1 = 'hills-doc/1';
export type DocFormat = 'markdown' | 'html';
export type DocKind = 'knowledge' | 'report';

export interface Section {
  /** `lead` = 第一段之前的前言；自訂段落為 `x-…` 或 null */
  key: string | null;
  title: string;
  text: string;
}

const KEY = /^[a-z][a-z0-9-]{0,31}$/;

/** `標題 {#key}` → [標題, key] */
export function splitHeading(h: string): [string, string | null] {
  const m = /^(.*?)\s*\{#([^}]+)\}\s*$/.exec(h.trim());
  if (m && KEY.test(m[2] ?? '')) return [(m[1] ?? '').trim(), m[2] ?? null];
  return [h.trim(), null];
}

/** Markdown 去除常見標記，作為擷取用純文字 */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?(\[![A-Z]+\]\s*)?|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function markdownSections(body: string): Section[] {
  const out: Section[] = [{ key: 'lead', title: '', text: '' }];
  const raw: string[][] = [[]];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const tl = line.trimStart();
    if (fence) {
      if (tl.startsWith(fence)) fence = null;
    } else if (tl.startsWith('```') || tl.startsWith('~~~')) {
      fence = tl.slice(0, 3);
    } else if (tl.startsWith('## ')) {
      const [title, key] = splitHeading(tl.slice(3));
      out.push({ key, title, text: '' });
      raw.push([]);
      continue;
    }
    raw[raw.length - 1]?.push(line);
  }
  out.forEach((s, i) => (s.text = plain((raw[i] ?? []).join('\n'))));
  return out[0]?.text ? out : out.slice(1);
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function htmlSections(body: string): Section[] {
  const doc = new DOMParser().parseFromString(sanitizeHtml(body), 'text/html');
  return [...doc.querySelectorAll('section[data-section], section')]
    .filter((el, i, all) => all.indexOf(el) === i)
    .map((el) => {
      const raw = el.getAttribute('data-section');
      const h = el.querySelector('h2');
      const title = h ? textOf(h) : '';
      const clone = el.cloneNode(true) as Element;
      clone.querySelector('h2')?.remove();
      clone.querySelectorAll('style').forEach((s) => s.remove());
      return { key: raw && KEY.test(raw) ? raw : null, title, text: textOf(clone) };
    });
}

export function parseSections(format: DocFormat, body: string): Section[] {
  return format === 'html' ? htmlSections(body) : markdownSections(body);
}

export function requiredKeys(kind: DocKind, hasCriteria = false): string[] {
  if (kind === 'knowledge') return ['summary', 'content'];
  return hasCriteria ? ['summary', 'criteria'] : ['summary'];
}

export function missingRequired(kind: DocKind, sections: Section[], hasCriteria = false): string[] {
  return requiredKeys(kind, hasCriteria).filter(
    (k) => !sections.some((s) => s.key === k && s.text.trim() !== ''),
  );
}

/** 段落 key 的顯示名稱（固定段落）；自訂段落用自己的標題 */
export function sectionLabel(key: string): string {
  const known: Record<string, string> = {
    summary: t('doc.section.summary'),
    content: t('doc.section.content'),
    points: t('doc.section.points'),
    sources: t('doc.section.sources'),
    criteria: t('doc.section.criteria'),
    outputs: t('doc.section.outputs'),
    issues: t('doc.section.issues'),
    next: t('doc.section.next'),
  };
  return known[key] ?? key;
}

/** 列表摘要：summary 段落，沒有時取前言或全文前 n 字 */
export function summaryOf(format: DocFormat, body: string, n = 140): string {
  const secs = parseSections(format, body);
  const s = secs.find((x) => x.key === 'summary') ?? secs.find((x) => x.key === 'lead');
  const text = s?.text ?? (format === 'html' ? '' : plain(body));
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

const KNOWLEDGE_KEYS = ['summary', 'content', 'points', 'sources'];
const REPORT_KEYS = ['summary', 'criteria', 'outputs', 'issues', 'next'];

/** 範本：固定段落 + 一行提示 */
export function templateFor(kind: DocKind, format: DocFormat): string {
  const keys = kind === 'knowledge' ? KNOWLEDGE_KEYS : REPORT_KEYS;
  if (format === 'markdown') {
    return keys
      .map((k) => `## ${sectionLabel(k)} {#${k}}\n${t(`doc.hint.${k}` as 'doc.hint.summary')}\n`)
      .join('\n');
  }
  const body = keys
    .map(
      (k) =>
        `  <section data-section="${k}">\n    <h2>${sectionLabel(k)}</h2>\n    <p>${t(`doc.hint.${k}` as 'doc.hint.summary')}</p>\n  </section>`,
    )
    .join('\n');
  return `<article data-hills-doc="1">\n${body}\n</article>\n`;
}

// ── HTML 清理（§16.16）──────────────────────────────

const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'base',
  'link',
  'meta',
  'frame',
  'frameset',
  'svg',
  'math',
];

/** style 內容：移除 @import 與非 data: 的 url() */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(?!['"]?data:)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '(');
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.hasAttribute?.('style'))
      el.setAttribute('style', cleanCss(el.getAttribute('style') ?? ''));
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      if (!src.startsWith('data:image/')) el.removeAttribute('src');
      el.removeAttribute('srcset');
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|#)/i.test(href)) el.removeAttribute('href');
    }
  });
}

/** 清理知識 / 報告 HTML：保留結構、樣式與 data: 圖片，移除腳本、事件、表單與外部資源 */
export function sanitizeHtml(html: string): string {
  // 環境不支援時（理論上不會發生）不輸出任何標記
  if (!DOMPurify.isSupported) {
    return html.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  hook();
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    ADD_TAGS: ['style', 'article', 'section', 'details', 'summary', 'figure', 'figcaption'],
    ADD_ATTR: ['data-hills-doc', 'data-section', 'open'],
    FORBID_TAGS,
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'background', 'ping'],
    ALLOW_DATA_ATTR: true,
  });
}
