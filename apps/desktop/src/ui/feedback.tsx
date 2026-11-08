/** 回饋與流程元件（docs/components.md「回饋」）。 */
import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { Button } from './button';

/** 動作失敗的錯誤訊息（role=alert）。 */
export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control border border-danger px-3 py-2 text-sm text-danger">
      {t('common.error', { message })}
    </p>
  );
}

/** 不可逆動作的二次確認（ui-spec 共通規則）。 */
export function ConfirmButton({
  label,
  message,
  onConfirm,
  size = 'sm',
}: {
  label: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  size?: 'sm' | 'md';
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="danger" size={size} onClick={() => setAsking(true)}>
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
          size="sm"
          autoFocus
          onClick={async () => {
            setAsking(false);
            await onConfirm();
          }}
        >
          {t('common.confirm')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
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
