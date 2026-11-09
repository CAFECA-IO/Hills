/**
 * 文件顯示與編輯（components.md v0.8：HtmlView、DocView、MarkdownEditor；D52、D55）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sanitizeHtml, type DocFormat } from '../doc-spec';
import { t } from '../i18n';
import { IconButton } from './button';
import { TextArea } from './form';
import { Markdown } from './markdown';
import { SegmentedControl } from './nav';

/** 注入沙盒的閱讀樣式：讀取外層的 CSS 變數值，讓深淺色一致 */
function readerCss(): string {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const fg = v('--color-fg', '#16202e');
  const muted = v('--color-muted', '#3b4656');
  const line = v('--color-line', '#d6dde8');
  const bg = v('--color-bg', '#f3f6fa');
  const primary = v('--color-primary', '#1f6feb');
  const font = v('--font-sans', 'system-ui, sans-serif');
  const surface = v('--color-surface', '#ffffff');
  const scheme = cs.colorScheme && cs.colorScheme !== 'normal' ? cs.colorScheme : 'light dark';
  return `:root{color-scheme:${scheme}}html,body{margin:0;padding:0;background:${surface};color:${fg};font-family:${font};font-size:14px;line-height:1.7;overflow:hidden}
body{padding:2px}
h1,h2,h3,h4{line-height:1.35;margin:1em 0 .4em}h1{font-size:1.25rem}h2{font-size:1.05rem;padding-bottom:.25rem;border-bottom:1px solid ${line}}h3{font-size:.95rem}
article>:first-child,section:first-child>h2{margin-top:0}
p{margin:.5em 0}a{color:${primary}}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto;font-size:.92em;margin:.5em 0}
th,td{border:1px solid ${line};padding:.3rem .6rem;text-align:left;vertical-align:top}th{background:${bg}}
code{background:${bg};border-radius:4px;padding:0 .25rem;font-size:.85em}pre{background:${bg};padding:.6rem;border-radius:8px;overflow-x:auto}pre code{padding:0}
blockquote{border-left:3px solid ${line};margin:.5em 0;padding-left:.75rem;color:${muted}}
img{max-width:100%}hr{border:0;border-top:1px solid ${line}}`;
}

/** 知識 / 報告 HTML：清理後放進不允許腳本的沙盒 iframe（technical-design §16.16） */
export function HtmlView({ html, className = '' }: { html: string; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style>${readerCss()}</style></head><body>${sanitizeHtml(html)}</body></html>`,
    [html],
  );
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let obs: ResizeObserver | null = null;
    const onLoad = () => {
      const d = f.contentDocument;
      if (!d) return;
      const fit = () => setHeight(Math.max(40, d.documentElement.scrollHeight));
      fit();
      obs = new ResizeObserver(fit);
      obs.observe(d.documentElement);
      d.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a');
        if (!a) return;
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) return;
        e.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
      });
    };
    f.addEventListener('load', onLoad);
    return () => {
      f.removeEventListener('load', onLoad);
      obs?.disconnect();
    };
  }, [doc]);
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <iframe
        ref={ref}
        title={t('doc.html.frame')}
        sandbox="allow-same-origin"
        srcDoc={doc}
        style={{ height }}
        className="w-full border-0"
      />
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        {t('doc.html.safe')}
      </p>
    </div>
  );
}

/** 依格式顯示文件；`source` 時顯示原始碼 */
export function DocView({
  format,
  body,
  source = false,
  toc = false,
  className = '',
}: {
  format: DocFormat;
  body: string;
  source?: boolean;
  toc?: boolean;
  className?: string;
}) {
  if (source) {
    return (
      <pre
        className={`overflow-x-auto rounded-control bg-bg p-3 font-mono text-xs whitespace-pre-wrap ${className}`}
      >
        {format === 'html' ? sanitizeHtml(body) : body}
      </pre>
    );
  }
  return format === 'html' ? (
    <HtmlView html={body} className={className} />
  ) : (
    <Markdown toc={toc} className={className}>
      {body}
    </Markdown>
  );
}

// ── Markdown 編輯器 ──────────────────────────────────

type Mode = 'edit' | 'preview' | 'split';

interface Edit {
  /** 包住選取文字 */
  wrap?: [string, string];
  /** 每行加上前綴 */
  line?: string;
  /** 插入區塊 */
  block?: () => string;
}

const TOOLS: {
  key: string;
  label: Parameters<typeof t>[0];
  icon: ReactNode;
  edit: Edit;
  hotkey?: string;
}[] = [
  { key: 'bold', label: 'md.tool.bold', icon: <b>B</b>, edit: { wrap: ['**', '**'] }, hotkey: 'b' },
  {
    key: 'italic',
    label: 'md.tool.italic',
    icon: <i>I</i>,
    edit: { wrap: ['*', '*'] },
    hotkey: 'i',
  },
  { key: 'heading', label: 'md.tool.heading', icon: <b>H</b>, edit: { line: '## ' } },
  { key: 'ul', label: 'md.tool.ul', icon: <span aria-hidden="true">•</span>, edit: { line: '- ' } },
  {
    key: 'ol',
    label: 'md.tool.ol',
    icon: <span aria-hidden="true">1.</span>,
    edit: { line: '1. ' },
  },
  {
    key: 'task',
    label: 'md.tool.task',
    icon: <span aria-hidden="true">☐</span>,
    edit: { line: '- [ ] ' },
  },
  {
    key: 'link',
    label: 'md.tool.link',
    icon: <span aria-hidden="true">↗</span>,
    edit: { wrap: ['[', '](https://)'] },
    hotkey: 'k',
  },
  {
    key: 'code',
    label: 'md.tool.code',
    icon: <span aria-hidden="true">{'{}'}</span>,
    edit: { wrap: ['`', '`'] },
  },
  {
    key: 'table',
    label: 'md.tool.table',
    icon: <span aria-hidden="true">⊞</span>,
    edit: { block: () => `| ${t('md.table.col')} | ${t('md.table.col')} |\n|---|---|\n|  |  |\n` },
  },
  {
    key: 'callout',
    label: 'md.tool.callout',
    icon: <span aria-hidden="true">!</span>,
    edit: { block: () => '> [!NOTE]\n> ' },
  },
];

/** 套用編輯，回傳新文字與新的選取範圍 */
export function applyEdit(
  value: string,
  start: number,
  end: number,
  e: Edit,
): [string, number, number] {
  const sel = value.slice(start, end);
  if (e.wrap) {
    const [a, b] = e.wrap;
    return [
      value.slice(0, start) + a + sel + b + value.slice(end),
      start + a.length,
      end + a.length,
    ];
  }
  if (e.line) {
    const ls = value.lastIndexOf('\n', start - 1) + 1;
    const block = value.slice(ls, end);
    const lines = block.split('\n').map((l) => e.line + l);
    const out = lines.join('\n');
    return [value.slice(0, ls) + out + value.slice(end), start + e.line.length, ls + out.length];
  }
  const pre = start > 0 && value[start - 1] !== '\n' ? '\n\n' : '';
  const ins = pre + (e.block?.() ?? '');
  return [value.slice(0, start) + ins + value.slice(end), start + ins.length, start + ins.length];
}

export function MarkdownEditor({
  value,
  onChange,
  rows = 12,
  label,
  invalid,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  label: string;
  invalid?: boolean;
  id?: string;
}) {
  const [mode, setMode] = useState<Mode>('edit');
  const area = useRef<HTMLTextAreaElement>(null);
  const run = (e: Edit) => {
    const el = area.current;
    if (!el) return;
    const [v, s, en] = applyEdit(value, el.selectionStart, el.selectionEnd, e);
    onChange(v);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s, en);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const tool = TOOLS.find((x) => x.hotkey === e.key.toLowerCase());
    if (!tool) return;
    e.preventDefault();
    run(tool.edit);
  };
  const editor = (
    <TextArea
      ref={area}
      id={id}
      rows={rows}
      value={value}
      invalid={invalid}
      aria-label={label}
      className="min-h-40 flex-1 font-mono text-xs"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKey}
    />
  );
  const preview = (
    <div
      className="min-h-40 flex-1 overflow-auto rounded-control border border-line p-3"
      aria-label={t('md.preview')}
    >
      {value.trim() ? (
        <Markdown>{value}</Markdown>
      ) : (
        <p className="text-sm text-muted">{t('md.empty')}</p>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        <div
          role="toolbar"
          aria-label={t('md.toolbar')}
          className="flex flex-wrap items-center gap-0.5"
        >
          {TOOLS.map((tool) => (
            <IconButton
              key={tool.key}
              size="sm"
              label={
                tool.hotkey ? `${t(tool.label)} (⌘${tool.hotkey.toUpperCase()})` : t(tool.label)
              }
              disabled={mode === 'preview'}
              onClick={() => run(tool.edit)}
            >
              {tool.icon}
            </IconButton>
          ))}
        </div>
        <SegmentedControl
          className="ml-auto"
          label={t('md.mode')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'edit', label: t('md.mode.edit') },
            { value: 'preview', label: t('md.mode.preview') },
            { value: 'split', label: t('md.mode.split') },
          ]}
        />
      </div>
      {mode === 'edit' && editor}
      {mode === 'preview' && preview}
      {mode === 'split' && (
        <div className="flex gap-3">
          {editor}
          {preview}
        </div>
      )}
    </div>
  );
}
