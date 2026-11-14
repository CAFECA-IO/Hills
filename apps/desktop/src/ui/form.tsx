/** 表單元件（docs/components.md「表單」）。 */
import { t } from '../i18n';
import { FOCUS_RING } from './button';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export type ControlSize = 'sm' | 'md';

type FieldCtx = { id: string; describedBy?: string; invalid: boolean; required: boolean };
const FieldContext = createContext<FieldCtx | null>(null);

const CONTROL =
  'rounded-control border bg-surface text-fg placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
/** 固定高度（不靠上下內距：WebKit 會忽略原生 select 的內距），docs/components.md。 */
const CONTROL_SIZE: Record<ControlSize, string> = {
  sm: 'h-7 px-2 py-0 text-sm',
  md: 'h-9 px-3 py-0 text-sm',
};
const AREA_SIZE: Record<ControlSize, string> = {
  sm: 'px-2 py-1 text-sm',
  md: 'px-3 py-2 text-sm',
};

function useControl(id: string | undefined, invalid: boolean | undefined) {
  const f = useContext(FieldContext);
  const bad = invalid ?? f?.invalid ?? false;
  return {
    id: id ?? f?.id,
    'aria-describedby': f?.describedBy,
    'aria-invalid': bad || undefined,
    'aria-required': f?.required || undefined,
    border: bad ? 'border-danger' : 'border-line',
  };
}

type Common = {
  size?: ControlSize;
  invalid?: boolean;
  /** bare：無框、透明底（只用於已有外框的容器內，例如指令面板的搜尋列） */
  appearance?: 'boxed' | 'bare';
};

const BARE = 'border-0 bg-transparent text-fg placeholder:text-muted outline-none';

/** 單行文字輸入。 */
export const TextInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & Common
>(function TextInput(
  { size = 'md', invalid, appearance = 'boxed', className = '', id, type = 'text', ...rest },
  ref,
) {
  const { border, ...a } = useControl(id, invalid);
  const look = appearance === 'bare' ? BARE : `${CONTROL} ${CONTROL_SIZE[size]} ${border}`;
  return <input ref={ref} type={type} className={`${look} ${className}`} {...a} {...rest} />;
});

/** 多行文字輸入。 */
export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & Common
>(function TextArea(
  { size = 'md', invalid, appearance = 'boxed', className = '', id, ...rest },
  ref,
) {
  const { border, ...a } = useControl(id, invalid);
  const look = appearance === 'bare' ? BARE : `${CONTROL} ${AREA_SIZE[size]} ${border}`;
  return <textarea ref={ref} className={`${look} ${className}`} {...a} {...rest} />;
});

/**
 * 下拉選單：原生 select（保留系統鍵盤與螢幕閱讀器行為），但取消系統外觀並畫自己的箭頭，
 * 讓 Mac（WebKit）與 Windows 的高度、圓角一致。`className` 套在外層（版面）。
 */
export const Select = forwardRef<
  HTMLSelectElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & Omit<Common, 'appearance'>
>(function Select({ size = 'md', invalid, className = '', id, ...rest }, ref) {
  const { border, ...a } = useControl(id, invalid);
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        ref={ref}
        className={`w-full min-w-0 appearance-none ${CONTROL} ${CONTROL_SIZE[size]} ${size === 'sm' ? 'pr-7' : 'pr-9'} ${border}`}
        {...a}
        {...rest}
      />
      <svg
        aria-hidden
        width={12}
        height={12}
        viewBox="0 0 12 12"
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted ${size === 'sm' ? 'right-2' : 'right-3'}`}
      >
        <path
          d="M3 4.5l3 3 3-3"
          stroke="currentColor"
          strokeWidth={1.6}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
});

/**
 * 自繪的勾選框外觀（design-system §5.2，D66）：原生 input `appearance-none` 疊在上面，
 * 鍵盤、表單與螢幕閱讀器行為不變；勾勾與橫線用 `peer-checked` / `peer-indeterminate` 顯示。
 */
const BOX_INPUT = `peer absolute inset-0 m-0 cursor-pointer appearance-none rounded border border-line bg-surface transition-colors duration-(--hills-motion) hover:border-primary checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary disabled:cursor-not-allowed disabled:border-line disabled:bg-bg disabled:checked:bg-muted disabled:checked:border-muted ${FOCUS_RING}`;

/** 核取方塊；有 `label` 時整列可點。`indeterminate` 顯示橫線（部分選取）。 */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
    label?: ReactNode;
    indeterminate?: boolean;
  }
>(function Checkbox({ label, className = '', indeterminate = false, ...rest }, ref) {
  const setRef = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = indeterminate;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  const box = (
    <span className={`relative inline-flex size-4.5 shrink-0 ${label ? '' : className}`}>
      <input ref={setRef} type="checkbox" className={BOX_INPUT} {...rest} />
      <svg
        aria-hidden="true"
        viewBox="0 0 18 18"
        className="pointer-events-none relative size-4.5 text-on-primary opacity-0 transition-opacity duration-(--hills-motion) peer-checked:opacity-100 peer-indeterminate:opacity-0"
      >
        <path
          d="M4.5 9.2l3 3 6-6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-0.5 w-2.5 -translate-1/2 rounded-full bg-on-primary opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  );
  if (!label) return box;
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:text-muted ${className}`}
    >
      {box}
      <span className="min-w-0">{label}</span>
    </label>
  );
});

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** 標示必填（驗證在送出時進行） */
  required?: boolean;
  className?: string;
} & (
  | { children: ReactNode; value?: undefined }
  | {
      children?: undefined;
      value: string;
      onChange: (v: string) => void;
      type?: 'text' | 'password';
      multiline?: boolean;
      placeholder?: string;
      autoFocus?: boolean;
    }
);

/**
 * 表單欄位：標籤 + 控制項 + 說明 + 錯誤。子元素的 TextInput / TextArea / Select
 * 會自動取得 id、aria-describedby 與 aria-invalid。
 * 也可不傳 children，以 value / onChange 直接產生文字輸入（簡易寫法）。
 */
export function Field(props: FieldProps) {
  const { label, hint, error, required = false, className = '' } = props;
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy =
    [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined;
  let control: ReactNode;
  if (props.value === undefined) {
    control = props.children;
  } else if (props.multiline) {
    control = (
      <TextArea
        className="min-h-24 w-full font-mono"
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <TextInput
        className="w-full"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: !!error, required }}>
      <div className={`flex flex-col gap-1 ${className}`}>
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
          {required && <span className="font-normal">{t('field.requiredMark')}</span>}
        </label>
        {control}
        {hint && (
          <p id={hintId} className="text-xs text-muted">
            {hint}
          </p>
        )}
        {error && (
          <p id={errId} role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

/** 單選按鈕；同一組用相同 `name`。有 `label` 時整列可點（外觀自繪，design-system §5.2）。 */
export const Radio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & { label?: ReactNode }
>(function Radio({ label, className = '', ...rest }, ref) {
  const dot = (
    <span className={`relative inline-flex size-4.5 shrink-0 ${label ? '' : className}`}>
      <input
        ref={ref}
        type="radio"
        className={`peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full border border-line bg-surface transition-colors duration-(--hills-motion) hover:border-primary checked:border-2 checked:border-primary disabled:cursor-not-allowed disabled:bg-bg disabled:checked:border-muted ${FOCUS_RING}`}
        {...rest}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 size-2 -translate-1/2 rounded-full bg-primary opacity-0 transition-opacity duration-(--hills-motion) peer-checked:opacity-100 peer-disabled:bg-muted"
      />
    </span>
  );
  if (!label) return dot;
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:text-muted ${className}`}
    >
      {dot}
      <span className="min-w-0">{label}</span>
    </label>
  );
});

/** 滑桿（原生 range）：時間軸、數值範圍。需提供 aria-label 與 aria-valuetext。 */
export const Slider = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'>
>(function Slider({ className = '', ...rest }, ref) {
  return (
    <input
      ref={ref}
      type="range"
      className={`accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className}`}
      {...rest}
    />
  );
});

export interface ChoiceOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  /** 卡片右側的標記（例如「Hills 建議」） */
  badge?: ReactNode;
  /** 虛線外框的「都不是」選項 */
  dashed?: boolean;
}

/**
 * 大面積的單選卡片（components.md v0.3「ChoiceCard」）：精靈中需要標題＋說明的選項。
 * WAI-ARIA radiogroup：只有選取的卡（未選時第一張）可 Tab 聚焦，方向鍵移動並選取。
 */
export function ChoiceCard<T extends string>({
  label,
  options,
  value,
  onChange,
  className = '',
}: {
  label: string;
  options: ChoiceOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  className?: string;
}) {
  const focusIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = ['ArrowDown', 'ArrowRight'].includes(e.key)
      ? 1
      : ['ArrowUp', 'ArrowLeft'].includes(e.key)
        ? -1
        : 0;
    if (!d || options.length === 0) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const n = (i < 0 ? (d > 0 ? 0 : options.length - 1) : i + d + options.length) % options.length;
    onChange(options[n].value);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[n]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex flex-col gap-2 ${className}`}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === focusIndex ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`flex w-full items-center gap-3.5 rounded-card px-4 py-3.5 text-left transition-colors duration-(--hills-motion) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              on
                ? 'border-2 border-primary bg-primary-soft'
                : `border border-line hover:bg-bg ${o.dashed ? 'border-dashed bg-bg' : 'bg-surface'}`
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-5 shrink-0 rounded-full ${on ? 'border-6 border-primary' : 'border-2 border-muted'}`}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={`text-base ${o.dashed && !on ? 'font-semibold text-muted' : 'font-bold'}`}
              >
                {o.title}
              </span>
              {o.description && <span className="text-xs text-muted">{o.description}</span>}
            </span>
            {o.badge}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 左右滑動的功能開關（components.md v0.5「Switch」）：開或關之後立即生效的設定或檢視。
 * 表單裡要按儲存才生效的選項用 Checkbox。
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  size = 'md',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const id = useId();
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'size-3' : 'size-4';
  const shift = size === 'sm' ? 'translate-x-3' : 'translate-x-4';
  const button = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? `${id}-label` : undefined}
      aria-describedby={description ? `${id}-desc` : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-(--hills-motion) motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING} ${track} ${checked ? 'bg-primary' : 'bg-line'}`}
    >
      <span
        aria-hidden="true"
        className={`rounded-full bg-surface shadow-sm transition-transform duration-(--hills-motion) motion-reduce:transition-none ${knob} ${checked ? shift : 'translate-x-0'}`}
      />
    </button>
  );
  if (!label) return button;
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="flex flex-col">
        <label
          id={`${id}-label`}
          htmlFor={id}
          className={`text-sm ${disabled ? 'text-muted' : 'cursor-pointer'}`}
        >
          {label}
        </label>
        {description && (
          <span id={`${id}-desc`} className="text-xs text-muted">
            {description}
          </span>
        )}
      </span>
      {button}
    </span>
  );
}
