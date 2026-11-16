/**
 * Markdown 內容（components.md「Markdown」v0.8，D55）：全 app 唯一的 Markdown 顯示入口。
 * GFM（表格、勾選清單、刪除線、自動連結）、提示框（> [!NOTE]）、`## 標題 {#key}`（移除 key 並作為錨點）、
 * 程式碼區塊（語言 + 複製）、目錄。不轉譯原始 HTML；外部圖片改成連結；連結以外部瀏覽器開啟。
 */
import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../i18n';
import { CitationMark } from './ask';

// ── remark 外掛（mdast 最小型別，避免依賴 @types/mdast）──────────
interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

const KEY = /\s*\{#([a-z][a-z0-9-]{0,31})\}\s*$/;
const CALLOUT = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/;

function walk(node: MdNode, fn: (n: MdNode) => void) {
  fn(node);
  node.children?.forEach((c) => walk(c, fn));
}

/** `## 標題 {#key}`：移除 key，h2 的 id 設為 `sec-key` */
function remarkSectionKeys() {
  return (tree: MdNode) =>
    walk(tree, (n) => {
      if (n.type !== 'heading') return;
      const last = n.children?.[n.children.length - 1];
      if (last?.type !== 'text' || !last.value) return;
      const m = KEY.exec(last.value);
      if (!m) return;
      last.value = last.value.replace(KEY, '');
      n.data = { ...n.data, hProperties: { ...n.data?.hProperties, id: `sec-${m[1]}` } };
    });
}

/** `> [!NOTE]` → 提示框 */
function remarkCallouts() {
  return (tree: MdNode) =>
    walk(tree, (n) => {
      if (n.type !== 'blockquote') return;
      const p = n.children?.[0];
      const first = p?.type === 'paragraph' ? p.children?.[0] : undefined;
      if (first?.type !== 'text' || !first.value) return;
      const m = CALLOUT.exec(first.value);
      if (!m) return;
      first.value = first.value.replace(CALLOUT, '');
      const kind = (m[1] ?? 'NOTE').toLowerCase();
      n.data = {
        ...n.data,
        hProperties: { dataCallout: kind },
      };
    });
}

/** 出處標示（v0.16，D70）：`[n]`（1…N）→ 出處編號；`uncited` 中的句子 → 淡色「推論」。 */
export interface CitationOptions {
  titles: Record<number, string>;
  uncited?: string[];
  /** 未通過檢驗的引述（v0.17，D73）→ 淡色「待確認」 */
  doubtful?: string[];
  onActivate?: (n: number) => void;
}

const CITE = /\[(\d{1,2})\]/g;

function citeNodes(text: string, opt: CitationOptions): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    const n = Number(m[1]);
    if (!(n in opt.titles)) continue;
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({
      type: 'citation',
      data: { hName: 'sup', hProperties: { dataCite: String(n) } },
      children: [{ type: 'text', value: String(n) }],
    } as MdNode);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

function splitText(text: string, opt: CitationOptions): MdNode[] {
  const doubtful = new Set((opt.doubtful ?? []).map((u) => u.trim()));
  const marks = [...(opt.uncited ?? []), ...doubtful]
    .map((u) => u.trim())
    .filter((u) => u.length >= 4 && text.includes(u));
  if (marks.length === 0) return citeNodes(text, opt);
  const out: MdNode[] = [];
  let rest = text;
  while (rest) {
    let best = -1;
    let hit = '';
    for (const u of marks) {
      const i = rest.indexOf(u);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        hit = u;
      }
    }
    if (best < 0) {
      out.push(...citeNodes(rest, opt));
      break;
    }
    if (best > 0) out.push(...citeNodes(rest.slice(0, best), opt));
    out.push({
      type: 'inferred',
      data: {
        hName: 'span',
        hProperties: { className: doubtful.has(hit) ? 'md-doubtful' : 'md-inferred' },
      },
      children: [{ type: 'text', value: hit }],
    } as MdNode);
    rest = rest.slice(best + hit.length);
  }
  return out;
}

function remarkCitations(opt: CitationOptions) {
  const visit = (n: MdNode) => {
    if (!n.children || ['code', 'inlineCode', 'citation', 'inferred'].includes(n.type)) return;
    n.children = n.children.flatMap((c) =>
      c.type === 'text' && c.value ? splitText(c.value, opt) : [c],
    );
    n.children.forEach(visit);
  };
  return () => (tree: MdNode) => visit(tree);
}

// ── 目錄 ───────────────────────────────────────────

export interface TocItem {
  id: string;
  title: string;
}

/** 從原文抓 H2（略過程式碼區塊）；有 `{#key}` 時錨點為 `sec-key` */
export function tocOf(md: string): TocItem[] {
  const out: TocItem[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    const tl = line.trimStart();
    if (tl.startsWith('```') || tl.startsWith('~~~')) fence = !fence;
    if (fence || !tl.startsWith('## ')) continue;
    const m = KEY.exec(tl);
    const title = tl.slice(3).replace(KEY, '').trim();
    if (m) out.push({ id: `sec-${m[1]}`, title });
  }
  return out;
}

// ── 元件 ───────────────────────────────────────────

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as
    ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const lang = /language-([\w-]+)/.exec(code?.props.className ?? '')?.[1] ?? '';
  const text = String(code?.props.children ?? '').replace(/\n$/, '');
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || t('md.code')}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t('md.copied') : t('md.copy')}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const CALLOUT_LABEL: Record<string, Parameters<typeof t>[0]> = {
  note: 'md.callout.note',
  tip: 'md.callout.tip',
  warning: 'md.callout.warning',
  important: 'md.callout.important',
  caution: 'md.callout.caution',
};

export function Markdown({
  children,
  className = '',
  id,
  variant = 'doc',
  toc = false,
  citations,
}: {
  children: string;
  className?: string;
  id?: string;
  /** `doc`：完整（標題層級、目錄）；`chat`：精簡 */
  variant?: 'doc' | 'chat';
  /** 顯示目錄（只在 doc；至少 2 個有 key 的段落） */
  toc?: boolean;
  /** 出處編號與推論句（問知識庫，D70） */
  citations?: CitationOptions;
}) {
  const items = toc && variant === 'doc' ? tocOf(children) : [];
  const body = (
    <div id={id} className={`prose-hills prose-${variant} min-w-0 break-words ${className}`}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={
          citations
            ? [remarkGfm, remarkSectionKeys, remarkCallouts, remarkCitations(citations)]
            : [remarkGfm, remarkSectionKeys, remarkCallouts]
        }
        components={{
          a: ({ href, children: c }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline"
            >
              {c}
            </a>
          ),
          img: ({ src, alt }) =>
            typeof src === 'string' && src.startsWith('data:image/') ? (
              <img src={src} alt={alt ?? ''} className="max-w-full rounded-control" />
            ) : (
              <a
                href={typeof src === 'string' ? src : undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline"
              >
                {alt || t('md.image')}
              </a>
            ),
          pre: ({ children: c }) => <CodeBlock>{c}</CodeBlock>,
          blockquote: ({ children: c, node }) => {
            const kind = (node?.properties?.dataCallout as string | undefined) ?? null;
            if (!kind) return <blockquote>{c}</blockquote>;
            const label = CALLOUT_LABEL[kind];
            return (
              <div role="note" className={`callout callout-${kind}`}>
                {label && <strong className="callout-title">{t(label)}</strong>}
                {c}
              </div>
            );
          },
          sup: ({ children: c, node }) => {
            const n = Number(node?.properties?.dataCite);
            if (!citations || !n) return <sup>{c}</sup>;
            return (
              <CitationMark
                n={n}
                title={citations.titles[n] ?? ''}
                onActivate={citations.onActivate}
              />
            );
          },
          span: ({ children: c, className: cn }) =>
            cn === 'md-doubtful' ? (
              <span className="text-muted" title={t('ask.doubtful.hint')}>
                {c}
                <span className="ml-1 rounded-sm bg-cite-soft px-1 text-2xs font-semibold text-cite-text">
                  {t('ask.doubtful')}
                </span>
              </span>
            ) : cn === 'md-inferred' ? (
              <span className="text-muted" title={t('ask.inferred.hint')}>
                {c}
                <span className="ml-1 rounded-sm bg-bg px-1 text-2xs font-semibold">
                  {t('ask.inferred')}
                </span>
              </span>
            ) : (
              <span className={cn}>{c}</span>
            ),
          input: ({ checked }) => (
            <input type="checkbox" checked={Boolean(checked)} disabled readOnly />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
  if (items.length < 2) return body;
  return (
    <div className="flex min-w-0 gap-6">
      <div className="min-w-0 flex-1">{body}</div>
      <nav
        aria-label={t('md.toc')}
        className="sticky top-0 hidden w-40 shrink-0 flex-col gap-1.5 self-start text-xs lg:flex"
      >
        <span className="font-bold text-muted">{t('md.toc')}</span>
        {items.map((it) => (
          <a key={it.id} href={`#${it.id}`} className="text-muted hover:text-primary">
            {it.title}
          </a>
        ))}
      </nav>
    </div>
  );
}
