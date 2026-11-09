/** 回饋與流程元件（docs/components.md「回饋」）。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * 剛完成的動作的短暫通知，可附「復原」（components.md v0.3「Toast」）。
 * 預設 10 秒後自動關閉，滑過或聚焦時暫停；Esc 關閉。同時只顯示一則（由呼叫端以 key 取代）。
 */
export function Toast({
  message,
  action,
  onClose,
  duration = 10_000,
}: {
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
  duration?: number;
}) {
  const [paused, setPaused] = useState(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (paused) return;
    const id = setTimeout(() => close.current(), duration);
    return () => clearTimeout(id);
  }, [paused, duration]);
  return (
    <div
      role="status"
      className="fixed bottom-7 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-full bg-fg px-4.5 py-2.5 text-sm text-surface shadow-lg"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <span>{message}</span>
      {action && (
        <button
          type="button"
          className="font-bold text-primary-soft underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-soft"
          onClick={() => {
            action.onClick();
            onClose();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
