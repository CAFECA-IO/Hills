/**
 * Markdown 內容（components.md「Markdown」v0.8，D55）：全 app 唯一的 Markdown 顯示入口。
 * GFM（表格、勾選清單、刪除線、自動連結）、提示框（> [!NOTE]）、`## 標題 {#key}`（移除 key 並作為錨點）、
 * 程式碼區塊（語言 + 複製）、目錄。不轉譯原始 HTML；外部圖片改成連結；連結以外部瀏覽器開啟。
 */
import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../i18n';

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
}: {
  children: string;
  className?: string;
  id?: string;
  /** `doc`：完整（標題層級、目錄）；`chat`：精簡 */
  variant?: 'doc' | 'chat';
  /** 顯示目錄（只在 doc；至少 2 個有 key 的段落） */
  toc?: boolean;
}) {
  const items = toc && variant === 'doc' ? tocOf(children) : [];
  const body = (
    <div id={id} className={`prose-hills prose-${variant} min-w-0 break-words ${className}`}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkSectionKeys, remarkCallouts]}
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
