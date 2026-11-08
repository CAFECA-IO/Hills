/** 版面元件（ui-spec「版面」「應用外框」，D43）：頂列標題與動作、⌘K 找人或指令。 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { MemberView } from './api';
import { StatusBadge } from './figures';
import { t, type MessageKey } from './i18n';

/** 頂列的兩個插槽：標題區與頁面動作區（由 Shell 提供 DOM 節點）。 */
export interface HeadSlots {
  title: HTMLElement | null;
  actions: HTMLElement | null;
}

export const HeadContext = createContext<HeadSlots>({ title: null, actions: null });

/** 頁面在頂列顯示標題、副標與動作（每頁只放一組）。 */
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const slots = useContext(HeadContext);
  return (
    <>
      {slots.title &&
        createPortal(
          <div className="flex min-w-0 flex-col justify-center">
            <h1 className="truncate text-lg leading-tight font-bold wide:text-xl">{title}</h1>
            {subtitle && <p className="truncate text-xs text-muted wide:text-sm">{subtitle}</p>}
          </div>,
          slots.title,
        )}
      {slots.actions && actions && createPortal(actions, slots.actions)}
    </>
  );
}

/** 指令面板的一個項目。 */
export interface Command {
  id: string;
  label: string;
  /** 分組標題的 i18n key */
  group: MessageKey;
  keywords?: string;
  member?: MemberView;
  run: () => void;
}

/** ⌘/Ctrl + K 開啟指令面板（ui-spec「共通規則」快捷鍵）。 */
export function useCommandShortcut(open: () => void) {
  const ref = useRef(open);
  useEffect(() => {
    ref.current = open;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** 頂列的「找人或指令 ⌘K」按鈕。 */
export function CommandButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm text-muted hover:text-fg"
    >
      <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
        <circle cx={7} cy={7} r={5} stroke="currentColor" strokeWidth={1.6} fill="none" />
        <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      </svg>
      <span>{t('cmd.button')}</span>
      <kbd className="rounded bg-bg px-1.5 text-xs">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

/** 指令面板：輸入過濾，↑↓ 選擇，Enter 執行，Esc 關閉。 */
export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(needle))
      : commands;
    return list.slice(0, 12);
  }, [q, commands]);
  const current = Math.min(sel, Math.max(shown.length - 1, 0));
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const listId = 'cmd-list';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-fg/20 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('cmd.title')}
        className="flex max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-card bg-surface shadow-lg"
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') run(shown[current]);
          }}
          placeholder={t('cmd.placeholder')}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[current] ? `cmd-${shown[current].id}` : undefined}
          className="border-b border-line bg-transparent px-4 py-3 outline-none"
        />
        <ul id={listId} role="listbox" className="scroll-panel flex-1 p-2">
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('cmd.none')}</li>}
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-control px-3 py-2 text-sm ${i === current ? 'bg-primary-soft text-primary' : ''}`}
            >
              <span className="truncate">{c.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                {c.member && <StatusBadge state={c.member.presence} />}
                {t(c.group)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
