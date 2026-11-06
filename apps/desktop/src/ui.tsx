/** 共用 UI 元件：只使用設計 token（styles/tokens.css），不寫死色碼。 */
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { t } from './i18n';

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'soft' | 'danger';
}) {
  // 每頁只有一個主按鈕（ui-spec「視覺語言」）；其他用 secondary / soft
  const styles = {
    primary: 'bg-primary font-bold text-on-primary hover:opacity-90',
    secondary: 'border border-line bg-surface font-semibold hover:bg-bg',
    soft: 'bg-primary-soft font-semibold text-primary hover:opacity-90',
    danger: 'border border-danger font-semibold text-danger hover:bg-danger hover:text-on-primary',
  }[variant];
  return (
    <button
      type="button"
      className={`min-h-9 rounded-full px-4 py-2 text-sm transition-colors duration-(--hills-motion) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  value,
  onChange,
  type = 'text',
  multiline = false,
  placeholder,
  autoFocus,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'password';
  multiline?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const cls =
    'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className={`${cls} min-h-24 font-mono`}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          type={type}
          className={cls}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-card bg-surface p-5 shadow-sm ${className}`}>{children}</section>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control border border-danger px-3 py-2 text-sm text-danger">
      {t('common.error', { message })}
    </p>
  );
}

/** 置中的單欄頁面（初次啟動流程用）。 */
export function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center p-8">
      <div className="flex w-full max-w-xl flex-col gap-5 pt-8">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** 顯示文字碼 + QR + 複製。QR SVG 由 Rust 端（qrcode crate）產生。 */
export function CodeBox({ code, qrSvg }: { code: string; qrSvg?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪貼簿不可用時使用者可手動選取
    }
  };
  return (
    <div className="flex flex-col items-center gap-3">
      {qrSvg && (
        <div
          className="rounded bg-qr p-2"
          role="img"
          aria-label={code}
          // 來源為本機 Rust（qrcode crate）產生的 SVG，不含外部輸入的標記
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
      )}
      <code className="w-full break-all rounded-control border border-line bg-bg p-3 text-xs select-all">
        {code}
      </code>
      <Button variant="secondary" onClick={copy}>
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </div>
  );
}

/** 不可逆動作的二次確認（ui-spec 共通規則）。 */
export function ConfirmButton({
  label,
  message,
  onConfirm,
}: {
  label: string;
  message: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="danger" className="px-3 py-1" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <div
      role="alertdialog"
      className="flex flex-col gap-2 rounded-control border border-danger p-3 text-sm"
    >
      <p>{message}</p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="px-3 py-1"
          onClick={async () => {
            setAsking(false);
            await onConfirm();
          }}
        >
          {t('common.confirm')}
        </Button>
        <Button variant="secondary" className="px-3 py-1" onClick={() => setAsking(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** 執行非同步動作並追蹤 busy / error。 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  /** 成功回傳 true（用於回傳 void 的動作）。 */
  const attempt = async (f: () => Promise<unknown>): Promise<boolean> => {
    let ok = false;
    await run(async () => {
      await f();
      ok = true;
    });
    return ok;
  };
  return { busy, error, run, attempt, setError };
}
