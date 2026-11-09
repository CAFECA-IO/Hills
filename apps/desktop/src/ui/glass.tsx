/**
 * 晨光山丘毛玻璃元件（docs/components.md v0.10「GlassPanel」「ScopeTag」「SwatchGroup」
 * 「Character、CharacterStage」「GlassNav」，D56）。只用設計 token。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { FOCUS_RING } from './button';

const GLASS =
  'border border-(--hills-glass-line) bg-(--hills-glass) shadow-(--hills-glass-shadow) backdrop-blur-(--hills-glass-blur) backdrop-saturate-[1.3]';

/**
 * 毛玻璃底層：放在內容「後面」的兄弟元素。backdrop-filter 會讓子孫的 position: fixed
 * 以它為準（對話框會錯位），所以模糊只畫在這一層，內容不放進去。
 */
export function GlassLayer({ radius = 'rounded-[22px]' }: { radius?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 -z-10 ${radius} ${GLASS}`}
    />
  );
}

const GlassContext = createContext(false);

/** 範圍內的 `Card` 改用毛玻璃外觀（設定頁的插畫背景上，D56）。 */
export function GlassScope({ children }: { children: ReactNode }) {
  return <GlassContext.Provider value>{children}</GlassContext.Provider>;
}

export const useGlass = () => useContext(GlassContext);

export type Scope = 'device' | 'me' | 'org';

const SCOPE_TONE: Record<Scope, string> = {
  device: 'bg-bg text-muted',
  me: 'bg-primary-soft text-primary',
  org: 'bg-level-year/15 text-fg',
};

/** 設定項目的影響範圍小標。`label` 由呼叫端以 i18n 提供。 */
export function ScopeTag({ scope, label }: { scope: Scope; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${SCOPE_TONE[scope]}`}
    >
      {label}
    </span>
  );
}

/** 放在插畫背景上的毛玻璃面板。 */
export function GlassPanel({
  title,
  scope,
  padding = 'md',
  className = '',
  children,
  id,
}: {
  title?: ReactNode;
  scope?: { scope: Scope; label: string };
  padding?: 'md' | 'none';
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`relative z-0 rounded-[22px] ${padding === 'md' ? 'px-6 py-5' : ''} ${className}`}
    >
      <GlassLayer />
      {(title || scope) && (
        <div className="mb-3 flex items-center gap-2.5">
          {title && <h2 className="flex-1 text-base font-bold">{title}</h2>}
          {scope && <ScopeTag scope={scope.scope} label={scope.label} />}
        </div>
      )}
      {children}
    </section>
  );
}

/** 一組色票單選。← → 移動並選取。 */
export function SwatchGroup({
  label,
  colors,
  value,
  onChange,
  optionLabel,
}: {
  label: string;
  colors: string[];
  value: number;
  onChange: (i: number) => void;
  /** 每個色票的無障礙名稱，例如「頭髮 第 2 色」 */
  optionLabel: (i: number) => string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const d =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + colors.length) % colors.length;
    onChange(n);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-3 text-sm">
      <span className="w-14 shrink-0 font-medium">{label}</span>
      <div className="flex flex-wrap gap-2.5">
        {colors.map((c, i) => (
          <button
            key={c}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={optionLabel(i)}
            tabIndex={value === i ? 0 : -1}
            onClick={() => onChange(i)}
            onKeyDown={(e) => move(e, i)}
            className={`size-8 cursor-pointer rounded-full border-2 border-(--hills-glass-line) shadow-sm ${FOCUS_RING} ${value === i ? 'outline-3 outline-offset-2 outline-fg' : ''}`}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

const reduceMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FADE_MS = 240;

/** 角色切換舞台：箭頭往前 / 往後，舊角色淡出、新角色從另一側淡入。 */
export function CharacterStage({
  count,
  index,
  onChange,
  label,
  prevLabel,
  nextLabel,
  children,
  className = '',
}: {
  count: number;
  index: number;
  onChange: (i: number) => void;
  label: string;
  prevLabel: string;
  nextLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const [phase, setPhase] = useState<'in' | 'out' | 'pre'>('in');
  const [dir, setDir] = useState(1);
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const go = (d: number) => {
    if (busy.current) return;
    const next = (index + d + count) % count;
    if (reduceMotion()) {
      onChange(next);
      return;
    }
    busy.current = true;
    setDir(d);
    setPhase('out');
    timers.current.push(
      window.setTimeout(() => {
        onChange(next);
        setPhase('pre');
        timers.current.push(
          window.setTimeout(() => {
            setPhase('in');
            busy.current = false;
          }, 30),
        );
      }, FADE_MS),
    );
  };
  const shift = phase === 'out' ? -28 * dir : phase === 'pre' ? 28 * dir : 0;
  const arrow = `flex size-13 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg ${GLASS} ${FOCUS_RING}`;
  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <div className="flex items-center gap-2">
        <button type="button" className={arrow} aria-label={prevLabel} onClick={() => go(-1)}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 4 L7 12 L15 20 L17.5 17.5 L12 12 L17.5 6.5 Z" fill="currentColor" />
          </svg>
        </button>
        <div
          role="img"
          aria-label={label}
          aria-live="polite"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') go(-1);
            if (e.key === 'ArrowRight') go(1);
          }}
          className={`rounded-card ${FOCUS_RING}`}
          style={{
            opacity: phase === 'in' ? 1 : 0,
            transform: `translateX(${shift}px)`,
            transition:
              phase === 'pre' ? 'none' : `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
          }}
        >
          {children}
        </div>
        <button type="button" className={arrow} aria-label={nextLabel} onClick={() => go(1)}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 4 L17 12 L9 20 L6.5 17.5 L12 12 L6.5 6.5 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
      <div className="flex gap-2" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className={`h-2 rounded-full transition-all duration-(--hills-motion) ${i === index ? 'w-5.5 bg-fg' : 'w-2 bg-fg/25'}`}
          />
        ))}
      </div>
    </div>
  );
}

export interface GlassNavItem<T extends string> {
  value: T;
  label: string;
  /** 數字徽章（例如待核准數） */
  count?: number;
  countLabel?: string;
  /** 提醒圓點的無障礙說明；有傳才顯示 */
  dotLabel?: string;
}

/** 毛玻璃膠囊導覽（設定分組）。選取中的為深色實心，`aria-current="page"`。 */
export function GlassNav<T extends string>({
  label,
  items,
  value,
  onChange,
  className = '',
}: {
  label: string;
  items: GlassNavItem<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={`flex flex-wrap justify-center gap-2.5 ${className}`}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => onChange(it.value)}
            className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors duration-(--hills-motion) ${FOCUS_RING} ${on ? 'border border-fg bg-fg text-bg' : GLASS}`}
          >
            {it.label}
            {it.dotLabel && (
              <span
                role="img"
                aria-label={it.dotLabel}
                className="size-2 rounded-full bg-warning"
              />
            )}
            {!!it.count && (
              <span
                aria-label={it.countLabel}
                className="rounded-full bg-primary px-1.5 text-2xs text-on-primary"
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
