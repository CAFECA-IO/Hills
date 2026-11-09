/** 浮層元件（docs/components.md「浮層」）：Dialog、Popover、Tooltip、Menu。 */
import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { t } from '../i18n';
import { Button, IconButton } from './button';

export type DialogWidth = 'sm' | 'md' | 'lg';
const WIDTH: Record<DialogWidth, string> = { sm: 'w-120', md: 'w-140', lg: 'w-150' };

/** 把焦點移到容器內（若焦點不在裡面），讓 Esc 與 Tab 在浮層內作用。 */
function useFocusInside(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, [ref]);
}

/** 點擊容器（以及 `also`，通常是觸發按鈕）外部時呼叫 onOutside。 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active = true,
  also?: RefObject<HTMLElement | null>,
) {
  const cb = useRef(onOutside);
  useEffect(() => {
    cb.current = onOutside;
  });
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (also?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) cb.current();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ref, active, also]);
}

/**
 * 模態對話框：遮罩、置中、Esc 與點遮罩關閉、開啟時聚焦。
 * `title` 會顯示為標題並作為 aria-label；`onSubmit` 時整個對話框是 form。
 */
export function Dialog({
  title,
  label,
  onClose,
  onSubmit,
  width = 'md',
  placement = 'center',
  padded = true,
  closeButton = false,
  dirty = false,
  alert = false,
  describedBy,
  children,
}: {
  title?: ReactNode;
  /** 沒有可見標題時的無障礙名稱 */
  label?: string;
  onClose: () => void;
  onSubmit?: () => void;
  width?: DialogWidth;
  placement?: 'center' | 'top';
  padded?: boolean;
  closeButton?: boolean;
  /** 有未儲存的修改：Esc、點遮罩、× 先詢問是否放棄 */
  dirty?: boolean;
  /** `role="alertdialog"`（確認、警告類，components ConfirmDialog / NoticeDialog） */
  alert?: boolean;
  /** 說明文字的 id（`aria-describedby`） */
  describedBy?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  useFocusInside(ref);
  const keepEditing = () => {
    setAsking(false);
    ref.current?.focus();
  };
  const requestClose = () => {
    if (dirty) setAsking(true);
    else onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (asking) keepEditing();
      else requestClose();
    }
  };
  const discard = asking && (
    <div
      role="alertdialog"
      aria-label={t('dialog.discard.message')}
      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-warning px-3 py-2 text-sm"
    >
      <span>{t('dialog.discard.message')}</span>
      <span className="flex gap-2">
        <Button variant="danger" size="sm" onClick={onClose}>
          {t('dialog.discard.confirm')}
        </Button>
        <Button variant="secondary" size="sm" autoFocus onClick={keepEditing}>
          {t('dialog.discard.keep')}
        </Button>
      </span>
    </div>
  );
  const cls = `flex max-w-[calc(100vw-2rem)] flex-col rounded-card bg-surface shadow-lg outline-none ${placement === 'top' ? 'max-h-[60vh]' : 'max-h-[90vh]'} ${padded ? 'scroll-panel gap-3 p-5' : 'overflow-hidden'} ${WIDTH[width]}`;
  const head = (title || closeButton) && (
    <div className="flex items-start justify-between gap-3">
      {title && <h2 className="text-lg font-bold">{title}</h2>}
      {closeButton && (
        <IconButton label={t('common.close')} size="sm" onClick={requestClose}>
          ×
        </IconButton>
      )}
    </div>
  );
  const aria = {
    role: alert ? 'alertdialog' : 'dialog',
    'aria-modal': true,
    'aria-describedby': describedBy,
    'aria-label': label ?? (typeof title === 'string' ? title : undefined),
    tabIndex: -1,
    onKeyDown,
  } as const;
  return (
    <div
      className={`fixed inset-0 z-40 flex justify-center bg-fg/20 ${placement === 'top' ? 'items-start pt-[12vh]' : 'items-center'}`}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      {onSubmit ? (
        <form
          ref={(el) => {
            ref.current = el;
          }}
          className={cls}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
          {...aria}
        >
          {head}
          {children}
          {discard}
        </form>
      ) : (
        <div
          ref={(el) => {
            ref.current = el;
          }}
          className={cls}
          {...aria}
        >
          {head}
          {children}
          {discard}
        </div>
      )}
    </div>
  );
}

/**
 * 非模態浮動面板（錨定在觸發元素旁）：Esc 關閉、可選擇點外面關閉。
 * 位置由呼叫端以 className 指定（例如 `absolute bottom-full left-0 mb-2`）。
 */
export function Popover({
  label,
  onClose,
  closeOnOutside = true,
  anchorRef,
  className = '',
  style,
  autoFocus = true,
  children,
}: {
  label: string;
  onClose: () => void;
  closeOnOutside?: boolean;
  /** 觸發按鈕：點它不算「外面」，由按鈕自己切換開關 */
  anchorRef?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, onClose, closeOnOutside, anchorRef);
  useEffect(() => {
    const el = ref.current;
    if (autoFocus && el && !el.contains(document.activeElement)) el.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={style}
      className={`z-20 rounded-card bg-surface shadow-lg outline-none ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

/** 動作選單：↑↓ 移動、Enter 執行、Esc 關閉。位置由 className 指定。 */
export function Menu({
  label,
  onClose,
  anchorRef,
  className = '',
  children,
}: {
  label: string;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLUListElement>(null);
  useOutsideClick(ref, onClose, true, anchorRef);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const move = (d: number) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + d + items.length) % items.length]?.focus();
  };
  return (
    <ul
      ref={ref}
      role="menu"
      aria-label={label}
      className={`z-20 min-w-44 rounded-control bg-surface py-1 text-sm shadow-lg ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {children}
    </ul>
  );
}

export function MenuItem({
  onSelect,
  disabled,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onSelect}
        className="w-full px-3 py-2 text-left outline-none hover:bg-bg focus-visible:bg-primary-soft focus-visible:text-primary disabled:opacity-50"
      >
        {children}
      </button>
    </li>
  );
}

/**
 * 滑過或聚焦觸發元素時顯示的說明卡（components.md v0.4「Tooltip」）。
 * 觸發元素加上 aria-describedby；離開、失焦或 Esc 時隱藏，卡片本身滑過時保持顯示。
 */
export function Tooltip({
  content,
  children,
  side = 'right',
  open,
  className = '',
}: {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'left' | 'right';
  open?: boolean;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const visible = open === true || show;
  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setShow(false);
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span
        id={id}
        role="tooltip"
        className={`absolute bottom-full z-30 mb-2.5 flex w-66 flex-col gap-1.5 rounded-card bg-surface p-3.5 text-left text-xs text-fg shadow-lg ${side === 'left' ? 'right-0' : 'left-0'} ${visible ? '' : 'hidden'}`}
      >
        {content}
      </span>
    </span>
  );
}
