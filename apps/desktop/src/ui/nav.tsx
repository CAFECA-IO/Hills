/** 切換類元件（docs/components.md「切換」）：SegmentedControl、Tabs。 */
import type { KeyboardEvent, ReactNode } from 'react';
import { FOCUS_RING } from './button';

export type Option<T extends string> = { value: T; label: ReactNode };

/** 方向鍵在同組按鈕間移動並選取（WAI-ARIA tabs 模式）。 */
function arrowSelect<T extends string>(
  e: KeyboardEvent,
  options: Option<T>[],
  value: T,
  onChange: (v: T) => void,
) {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const i = options.findIndex((o) => o.value === value);
  const next = options[(i + d + options.length) % options.length];
  onChange(next.value);
  const list = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
  list[(i + d + options.length) % options.length]?.focus();
}

/** 膠囊切換：同一區塊的檢視或期間切換（2–4 個選項）。 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`inline-flex rounded-full bg-surface p-1 shadow-sm ${className}`}
      onKeyDown={(e) => arrowSelect(e, options, value, onChange)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors duration-(--hills-motion) ${FOCUS_RING} ${value === o.value ? 'bg-primary text-on-primary' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 底線分頁：切換同一面板內的不同內容區。`fill` 時分頁平均佔滿寬度。 */
export function Tabs<T extends string>({
  label,
  options,
  value,
  onChange,
  fill = false,
  className = '',
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`flex gap-1 border-b border-line ${className}`}
      onKeyDown={(e) => arrowSelect(e, options, value, onChange)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm ${fill ? 'flex-1 px-2' : ''} ${FOCUS_RING} ${value === o.value ? 'border-primary font-bold text-primary' : 'border-transparent text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 精靈的步驟指示（components.md v0.3「Stepper」）：只做顯示，不可點。
 * `vertical`（v0.14，D67）：直排，已完成的步驟下方可顯示所選內容（`details`）。
 */
export function Stepper({
  label,
  steps,
  current,
  vertical = false,
  details,
  className = '',
}: {
  label: string;
  steps: string[];
  current: number;
  vertical?: boolean;
  details?: (string | undefined)[];
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={`flex text-sm ${vertical ? 'flex-col gap-1' : 'items-center gap-2.5'} ${className}`}
    >
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'on' : 'todo';
        const detail = state === 'done' ? details?.[i] : undefined;
        return (
          <span
            key={s}
            className={`flex items-center gap-2.5 ${vertical ? `rounded-control px-2.5 py-2 ${state === 'on' ? 'bg-primary-soft' : ''}` : ''}`}
          >
            {i > 0 && !vertical && <span aria-hidden="true" className="h-0.5 w-8 bg-line" />}
            <span
              aria-hidden="true"
              className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                state === 'done'
                  ? 'bg-st-online text-on-primary'
                  : state === 'on'
                    ? 'bg-primary text-on-primary'
                    : 'border-2 border-line text-muted'
              }`}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                aria-current={state === 'on' ? 'step' : undefined}
                className={
                  state === 'on' ? 'font-bold text-primary' : state === 'done' ? '' : 'text-muted'
                }
              >
                {s}
              </span>
              {detail && <span className="truncate text-xs text-muted">{detail}</span>}
            </span>
          </span>
        );
      })}
    </nav>
  );
}
