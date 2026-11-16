/**
 * 問答與一年活動的元件（docs/components.md v0.16「ActivityGrid」「CitationMark」「SourceCard」「ChatComposer」，D70）。
 * 只用設計 token。
 */
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { FOCUS_RING } from './button';
import { t } from '../i18n';

// ── ActivityGrid ─────────────────────────────────────

export interface ActivityDay {
  /** `YYYY-MM-DD`（本機時區） */
  date: string;
  count: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 本機日期字串。 */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 該日所在週的星期一。 */
export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

export interface GridCell {
  date: string;
  count: number;
  level: number;
  future: boolean;
}

/** 53 週 × 7 天（週一開始），最後一週包含 `end`。 */
export function activityWeeks(
  days: ActivityDay[],
  end: Date,
  levels: number[] = [1, 2, 4, 7],
): { week: string; cells: GridCell[] }[] {
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const endKey = dayKey(end);
  const start = mondayOf(end);
  start.setDate(start.getDate() - 52 * 7);
  const out: { week: string; cells: GridCell[] }[] = [];
  for (let w = 0; w < 53; w++) {
    const cells: GridCell[] = [];
    const monday = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7);
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + d);
      const key = dayKey(day);
      const count = counts.get(key) ?? 0;
      const level = levels.reduce((l, min, i) => (count >= min ? i + 1 : l), 0);
      cells.push({ date: key, count, level, future: key > endKey });
    }
    out.push({ week: dayKey(monday), cells });
  }
  return out;
}

const LEVEL_BG = [
  'bg-activity-0',
  'bg-activity-1',
  'bg-activity-2',
  'bg-activity-3',
  'bg-activity-4',
];
const ROW_LABEL = [
  'scrum.weekday.1',
  'scrum.weekday.2',
  'scrum.weekday.3',
  'scrum.weekday.4',
  'scrum.weekday.5',
  'scrum.weekday.6',
  'scrum.weekday.0',
] as const;

/**
 * 一年的每日數量格子：53 欄 × 7 列，整體一個 Tab 停點；← → 逐週、↑ ↓ 逐日，Enter 選取該週。
 */
export function ActivityGrid({
  days,
  end = new Date(),
  levels,
  selectedWeek = null,
  onSelectWeek,
  label,
  cellLabel,
  monthLabel,
}: {
  days: ActivityDay[];
  end?: Date;
  levels?: number[];
  selectedWeek?: string | null;
  onSelectWeek?: (week: string) => void;
  label: string;
  cellLabel: (cell: GridCell) => string;
  /** 月份標籤（0–11 → 文字） */
  monthLabel: (month: number) => string;
}) {
  const weeks = useMemo(() => activityWeeks(days, end, levels), [days, end, levels]);
  const last = weeks.length - 1;
  const todayRow = (end.getDay() + 6) % 7;
  const [focus, setFocus] = useState<[number, number]>([last, todayRow]);
  const ref = useRef<HTMLDivElement>(null);
  const [fw, fd] = focus;
  const move = (dw: number, dd: number) => {
    let w = Math.min(last, Math.max(0, fw + dw));
    let d = fd + dd;
    if (d < 0) {
      d = 6;
      w = Math.max(0, w - 1);
    } else if (d > 6) {
      d = 0;
      w = Math.min(last, w + 1);
    }
    if (weeks[w]?.cells[d]?.future) return;
    setFocus([w, d]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k === 'ArrowLeft') move(-1, 0);
    else if (k === 'ArrowRight') move(1, 0);
    else if (k === 'ArrowUp') move(0, -1);
    else if (k === 'ArrowDown') move(0, 1);
    else if (k === 'Home') setFocus([0, fd]);
    else if (k === 'End') setFocus([last, todayRow]);
    else if ((k === 'Enter' || k === ' ') && onSelectWeek) {
      const wk = weeks[fw];
      if (wk) onSelectWeek(wk.week);
    } else return;
    e.preventDefault();
  };
  const focused = weeks[fw]?.cells[fd];
  const months = weeks.map((w, i) => {
    const d = new Date(`${w.week}T00:00:00`);
    const prev = i > 0 ? new Date(`${weeks[i - 1]!.week}T00:00:00`) : null;
    return !prev || prev.getMonth() !== d.getMonth() ? monthLabel(d.getMonth()) : '';
  });
  return (
    <div className="flex min-w-0 gap-1.5">
      <div
        aria-hidden="true"
        className="flex flex-col gap-[3px] pt-4 text-[10px] leading-[10px] text-muted"
      >
        {ROW_LABEL.map((k, i) => (
          <span key={k} className="h-2.5 w-4">
            {i % 2 === 0 ? t(k) : ''}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div aria-hidden="true" className="flex gap-[3px] text-[10px] leading-3 text-muted">
          {months.map((m, i) => (
            <span key={weeks[i]!.week} className="w-2.5 overflow-visible whitespace-nowrap">
              {m}
            </span>
          ))}
        </div>
        <div
          ref={ref}
          role="grid"
          aria-label={label}
          aria-activedescendant={focused ? `ag-${focused.date}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className={`flex gap-[3px] rounded-sm ${FOCUS_RING}`}
        >
          {weeks.map((w, wi) => {
            const selected = selectedWeek === w.week;
            return (
              <div
                key={w.week}
                role="row"
                aria-selected={onSelectWeek ? selected : undefined}
                onClick={() => {
                  setFocus([wi, fd]);
                  onSelectWeek?.(w.week);
                }}
                className={`flex flex-col gap-[3px] rounded-[3px] ${onSelectWeek ? 'cursor-pointer' : ''} ${selected ? 'outline-2 outline-offset-1 outline-fg' : ''}`}
              >
                {w.cells.map((c, di) => {
                  const isFocus = wi === fw && di === fd;
                  const text = c.future ? '' : cellLabel(c);
                  return (
                    <span
                      key={c.date}
                      id={`ag-${c.date}`}
                      role="gridcell"
                      aria-label={text || undefined}
                      title={text || undefined}
                      className={`block size-2.5 rounded-[2px] ${c.future ? 'bg-transparent' : LEVEL_BG[c.level]} ${isFocus ? 'ring-2 ring-primary ring-offset-1 ring-offset-surface' : ''}`}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 圖例「少 … 多」。 */
export function ActivityLegend({ less, more }: { less: string; more: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span>{less}</span>
      {LEVEL_BG.map((c) => (
        <span key={c} aria-hidden="true" className={`size-2.5 rounded-[2px] ${c}`} />
      ))}
      <span>{more}</span>
    </span>
  );
}

// ── CitationMark ─────────────────────────────────────

/** 本文中的出處編號 `[n]`。 */
export function CitationMark({
  n,
  title,
  onActivate,
}: {
  n: number;
  title: string;
  onActivate?: (n: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label={t('ask.cite', { n, title })}
      title={title}
      onClick={() => onActivate?.(n)}
      className={`mx-0.5 inline-flex min-w-5 items-center justify-center rounded-md bg-cite-soft px-1 align-[1px] text-xs leading-4 font-bold text-cite-text hover:opacity-80 ${FOCUS_RING}`}
    >
      {n}
    </button>
  );
}

// ── SourceCard ───────────────────────────────────────

/** 參考卡：編號、標題、說明；整張可點。 */
export function SourceCard({
  n,
  title,
  meta,
  icon,
  onOpen,
  highlighted = false,
  id,
  sections,
}: {
  n: number;
  title: string;
  meta: string;
  icon?: ReactNode;
  onOpen: () => void;
  highlighted?: boolean;
  id?: string;
  /** 同一出處的多個段落（components v0.17） */
  sections?: { n: number; label: string; excerpt: string; id?: string }[];
}) {
  const badge = (k: number) => (
    <span className="inline-flex min-w-5 shrink-0 justify-center rounded-md bg-cite-soft px-1 text-xs leading-4 font-bold text-cite-text">
      {k}
    </span>
  );
  return (
    <button
      id={id}
      type="button"
      onClick={onOpen}
      className={`flex w-full min-w-0 items-start gap-2.5 rounded-control border bg-surface px-3 py-2 text-left transition-colors duration-(--hills-motion) hover:border-primary ${highlighted ? 'border-primary' : 'border-line'} ${FOCUS_RING}`}
    >
      {!sections?.length && <span className="mt-0.5">{badge(n)}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          {icon && (
            <span aria-hidden="true" className="shrink-0 text-muted">
              {icon}
            </span>
          )}
          <span className="truncate">{title}</span>
        </span>
        <span className="truncate text-xs text-muted">{meta}</span>
        {sections && sections.length > 0 && (
          <span className="mt-1 flex flex-col gap-1.5">
            {sections.map((sec) => (
              <span key={sec.n} id={sec.id} className="flex items-start gap-2 text-xs">
                {badge(sec.n)}
                <span className="flex min-w-0 flex-col">
                  {sec.label && <span className="truncate font-semibold">{sec.label}</span>}
                  <span className="line-clamp-2 text-muted">{sec.excerpt}</span>
                </span>
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

// ── ChatComposer ─────────────────────────────────────

/** 多行輸入 + 送出 / 停止。Enter 送出、Shift+Enter 換行、輸入法組字中不送出。 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  busy = false,
  onStop,
  label,
  placeholder,
  before,
  hint,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  onStop?: () => void;
  label: string;
  placeholder?: string;
  before?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const empty = value.trim() === '';
  const rows = Math.min(6, Math.max(1, value.split('\n').length));
  const onKeyDown: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!busy && !empty && !disabled) onSubmit();
  };
  return (
    <div className="flex flex-col gap-2">
      {before}
      <div className="flex items-end gap-2">
        <textarea
          aria-label={label}
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={`min-h-10 flex-1 resize-none rounded-control border border-line bg-surface px-3 py-2 text-sm leading-5 placeholder:text-muted disabled:cursor-not-allowed disabled:bg-bg ${FOCUS_RING}`}
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className={`h-10 shrink-0 rounded-control border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-bg ${FOCUS_RING}`}
          >
            {t('ask.stop')}
          </button>
        ) : (
          <button
            type="button"
            aria-label={t('ask.send')}
            title={t('ask.send')}
            disabled={empty || disabled}
            onClick={onSubmit}
            className={`flex size-10 shrink-0 items-center justify-center rounded-control bg-primary text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-muted ${FOCUS_RING}`}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
