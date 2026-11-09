/** 顯示類元件（docs/components.md「顯示」）。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { FOCUS_RING } from './button';
import { GlassLayer, useGlass } from './glass';
import { EmptyIllustration, Skeleton, type EmptyArt, type SkeletonVariant } from './empty';

/** 內容卡片：一個主題一張（摘要圖卡規則見 ui-spec「視覺語言」）。 */
export function Card({
  children,
  className = '',
  padding = 'md',
}: {
  children: ReactNode;
  className?: string;
  padding?: 'sm' | 'md' | 'none';
}) {
  const p = { sm: 'p-4', md: 'p-5', none: '' }[padding];
  const glass = useGlass();
  if (glass) {
    return (
      <section className={`relative z-0 rounded-card ${p} ${className}`}>
        <GlassLayer radius="rounded-card" />
        {children}
      </section>
    );
  }
  return (
    <section className={`rounded-card bg-surface shadow-sm ${p} ${className}`}>{children}</section>
  );
}

/** 卡片或區塊上方的小標（這張卡回答什麼）。 */
export function SectionLabel({
  children,
  tone = 'muted',
  as: Tag = 'p',
  className = '',
}: {
  children: ReactNode;
  tone?: 'muted' | 'primary' | 'danger' | 'warning' | 'success';
  as?: 'p' | 'h2' | 'h3';
  className?: string;
}) {
  const color = {
    muted: 'text-muted',
    primary: 'text-primary',
    danger: 'text-danger',
    warning: 'text-warning',
    success: 'text-st-online-text',
  }[tone];
  return <Tag className={`text-xs font-bold tracking-wider ${color} ${className}`}>{children}</Tag>;
}

export type BadgeTone = 'neutral' | 'primary' | 'solid' | 'alert';

/** 小標記：計數、標籤、狀態文字。不可點擊（可點擊的用 Chip）。 */
export function Badge({
  children,
  tone = 'neutral',
  className = '',
  label,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  /** 數字徽章的無障礙說明（例如「3 則未讀」） */
  label?: string;
}) {
  const style = {
    neutral: 'border border-line text-muted',
    primary: 'bg-primary-soft font-bold text-primary',
    solid: 'bg-primary text-on-primary',
    alert: 'bg-st-busy font-bold text-on-primary',
  }[tone];
  return (
    <span
      aria-label={label}
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 text-2xs leading-4.5 ${style} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * 可點擊的膠囊：篩選條件、主題、關聯項目、訊息上的快速動作。
 * 傳入 `selected` 時為切換型（aria-pressed），不傳時為一般動作。
 */
export function Chip({
  selected,
  className = '',
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type={type ?? 'button'}
      aria-pressed={selected}
      className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${selected ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-line bg-surface hover:text-primary'} ${className}`}
      {...rest}
    />
  );
}

/** 空狀態：說明為什麼是空的，並提供（至多一個）主要動作。 */
export function EmptyState({
  children,
  action,
  className = '',
  art = 'generic',
  loading = false,
  skeleton = 'list',
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  /** 說明上方的插畫；行內空狀態用 none（components.md v0.7） */
  art?: EmptyArt | 'none';
  /** 資料還沒載入：改顯示骨架 */
  loading?: boolean;
  skeleton?: SkeletonVariant;
}) {
  if (loading) {
    return (
      <div className={className}>
        <Skeleton variant={skeleton} />
      </div>
    );
  }
  if (art === 'none') {
    return (
      <div className={`flex flex-col items-start gap-2 text-sm text-muted ${className}`}>
        <p>{children}</p>
        {action}
      </div>
    );
  }
  return (
    <div
      className={`flex flex-col items-center gap-3 py-6 text-center text-sm text-muted ${className}`}
    >
      <EmptyIllustration kind={art} />
      <p>{children}</p>
      {action}
    </div>
  );
}

/** 進度條，value 為 0–1。`barClassName` 可換成層級色（例如 bg-level-week）。 */
export function ProgressBar({
  value,
  label,
  size = 'md',
  barClassName = 'bg-primary',
  className = '',
}: {
  value: number;
  label: string;
  size?: 'sm' | 'md';
  barClassName?: string;
  className?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={`overflow-hidden rounded-full bg-line ${size === 'sm' ? 'h-2' : 'h-2.5'} ${className}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-(--hills-motion) ${barClassName}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** 快捷鍵提示。 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded bg-bg px-1.5 font-sans text-xs text-muted">{children}</kbd>;
}
