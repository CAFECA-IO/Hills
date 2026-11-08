/** 按鈕類元件（docs/components.md「按鈕」）。只用設計 token。 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-primary font-bold text-on-primary hover:opacity-90 disabled:bg-line disabled:text-muted disabled:opacity-100',
  secondary: 'border border-line bg-surface font-semibold hover:bg-bg',
  soft: 'bg-primary-soft font-semibold text-primary hover:opacity-90',
  danger: 'border border-danger font-semibold text-danger hover:bg-danger hover:text-on-primary',
  ghost: 'font-semibold text-muted hover:bg-bg hover:text-fg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-7 px-3 py-1 text-sm',
  md: 'min-h-9 px-4 py-2 text-sm',
};

type Native = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * 文字按鈕。每頁只有一個 primary（ui-spec「視覺語言」），其他用 secondary / soft / ghost；
 * 不可逆動作用 danger 並搭配 ConfirmButton。
 */
export const Button = forwardRef<
  HTMLButtonElement,
  Native & { variant?: ButtonVariant; size?: ButtonSize; busy?: boolean }
>(function Button(
  { variant = 'primary', size = 'md', busy = false, className = '', disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
});

/** 只有圖示的按鈕；`label` 必填，作為 aria-label 與滑過提示。 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<Native, 'children'> & {
    label: string;
    children: ReactNode;
    variant?: 'ghost' | 'secondary' | 'soft';
    size?: ButtonSize;
  }
>(function IconButton(
  { label, variant = 'ghost', size = 'md', className = '', type, children, ...rest },
  ref,
) {
  const box = size === 'sm' ? 'h-7 min-w-7 text-sm' : 'h-9 min-w-9 text-base';
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full px-1.5 transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${VARIANT[variant]} ${box} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

/** 行內文字連結樣式的按鈕（不換頁的次要動作，例如「清除篩選」「預覽」）。 */
export const LinkButton = forwardRef<
  HTMLButtonElement,
  Native & { tone?: 'primary' | 'muted' | 'danger' }
>(function LinkButton({ tone = 'primary', className = '', type, ...rest }, ref) {
  const color = {
    primary: 'text-primary',
    muted: 'text-muted hover:text-fg',
    danger: 'text-danger',
  }[tone];
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={`rounded-sm underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${color} ${className}`}
      {...rest}
    />
  );
});

/**
 * 沒有預設外觀的可點擊表面：清單列、卡片、成員、星星等自訂外觀的互動區。
 * 提供 button 語意、鍵盤操作與焦點環；外觀由呼叫端以 token class 決定。
 */
export const Pressable = forwardRef<HTMLButtonElement, Native>(function Pressable(
  { className = '', type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={`text-left disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${className}`}
      {...rest}
    />
  );
});

/**
 * 清單中的可選列（對話清單、任務選擇、成員清單）：整列可點、hover 底色、
 * `selected` 時以天空霧底色標示並設定 aria-current。
 */
export const ListButton = forwardRef<HTMLButtonElement, Native & { selected?: boolean }>(
  function ListButton({ selected = false, className = '', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition-colors duration-(--hills-motion) disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${selected ? 'bg-primary-soft font-semibold text-primary' : 'hover:bg-bg'} ${className}`}
        {...rest}
      />
    );
  },
);
