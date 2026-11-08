/** 表單元件（docs/components.md「表單」）。 */
import { t } from '../i18n';
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

/** 核取方塊；有 `label` 時整列可點。 */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & { label?: ReactNode }
>(function Checkbox({ label, className = '', ...rest }, ref) {
  const box = (
    <input
      ref={ref}
      type="checkbox"
      className={`size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${label ? '' : className}`}
      {...rest}
    />
  );
  if (!label) return box;
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm ${className}`}>
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

/** 單選按鈕；同一組用相同 `name`。有 `label` 時整列可點。 */
export const Radio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & { label?: ReactNode }
>(function Radio({ label, className = '', ...rest }, ref) {
  const dot = (
    <input
      ref={ref}
      type="radio"
      className={`size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${label ? '' : className}`}
      {...rest}
    />
  );
  if (!label) return dot;
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm ${className}`}>
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
