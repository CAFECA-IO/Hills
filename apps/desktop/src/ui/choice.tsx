/** 設定型對話框的選擇元件（docs/components.md v0.13「ToggleChip」「OptionTile」，D66）。 */
import type { KeyboardEvent, ReactNode } from 'react';
import { FOCUS_RING } from './button';

/** 多選膠囊：選取時晴藍框、淡藍底、前置 ✓。 */
export function ToggleChip({
  checked,
  onChange,
  children,
  disabled = false,
  title,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  /** 停用時說明原因 */
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:border-line disabled:bg-bg disabled:font-normal disabled:text-muted ${FOCUS_RING} ${
        checked
          ? 'border-primary bg-primary-soft font-semibold text-primary'
          : 'border-line bg-surface text-fg hover:text-primary'
      } ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 14 14"
        className={`size-3.5 shrink-0 transition-opacity duration-(--hills-motion) ${checked ? 'opacity-100' : 'w-0 opacity-0'}`}
      >
        <path
          d="M3 7.2l2.6 2.6L11 4.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </button>
  );
}

export interface TileOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

const COLS = ['grid-cols-1', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3'];

/**
 * 單選小卡：圖示、標題、一行說明。WAI-ARIA radiogroup：只有選取的卡可 Tab 聚焦，
 * 方向鍵移動並選取（略過停用的卡）。
 */
export function OptionTile<T extends string>({
  label,
  options,
  value,
  onChange,
  columns,
  className = '',
}: {
  label: string;
  options: TileOption<T>[];
  value: T;
  onChange: (v: T) => void;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const cols = columns ?? (Math.min(3, options.length) as 1 | 2 | 3);
  const enabled = options.filter((o) => !o.disabled);
  const focusValue = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = ['ArrowDown', 'ArrowRight'].includes(e.key)
      ? 1
      : ['ArrowUp', 'ArrowLeft'].includes(e.key)
        ? -1
        : 0;
    if (!d || enabled.length === 0) return;
    e.preventDefault();
    const i = enabled.findIndex((o) => o.value === value);
    const n = (i < 0 ? 0 : i + d + enabled.length) % enabled.length;
    const next = enabled[n]!;
    onChange(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`grid gap-2 ${COLS[cols]} ${className}`}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            disabled={o.disabled}
            tabIndex={o.value === focusValue ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`relative flex min-w-0 rounded-control px-3 py-2.5 ${o.description ? 'items-start gap-2.5 text-left' : 'flex-col items-center gap-1 text-center'} transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:border-line disabled:bg-bg disabled:text-muted ${FOCUS_RING} ${
              on
                ? 'border-2 border-primary bg-primary-soft'
                : 'border border-line bg-surface hover:border-primary'
            }`}
          >
            {o.icon && (
              <span
                aria-hidden="true"
                className={`flex size-4.5 shrink-0 ${o.description ? 'mt-0.5' : ''} items-center justify-center ${on ? 'text-primary' : 'text-muted'}`}
              >
                {o.icon}
              </span>
            )}
            <span className={`flex min-w-0 flex-1 flex-col gap-0.5 ${o.description ? 'pr-3' : ''}`}>
              <span className={`text-sm font-semibold ${on ? 'text-primary' : ''}`}>{o.title}</span>
              {o.description && (
                <span className="text-xs leading-snug text-muted">{o.description}</span>
              )}
            </span>
            <span
              aria-hidden="true"
              className={`absolute top-2 right-2 size-2 rounded-full transition-colors duration-(--hills-motion) ${on ? 'bg-primary' : 'bg-transparent'}`}
            />
          </button>
        );
      })}
    </div>
  );
}
