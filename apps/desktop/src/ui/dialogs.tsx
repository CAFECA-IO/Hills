/**
 * 統一的確認對話框與分級通知對話框（components.md「ConfirmDialog」「NoticeDialog」v0.6）。
 * 需要使用者確認的動作、需要同意的條文、一定要讀到的通知都用這裡的元件，不在各頁手寫。
 */
import { useId, useState } from 'react';
import { t } from '../i18n';
import { Button } from './button';
import { ErrorText } from './feedback';
import { Checkbox } from './form';
import { Markdown } from './markdown';
import { Dialog } from './overlay';

export function ConfirmDialog({
  title,
  body,
  tone = 'primary',
  confirmLabel,
  cancelLabel,
  acknowledge,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  tone?: 'primary' | 'danger';
  confirmLabel?: string;
  cancelLabel?: string;
  /** 簽署條文：勾選後主按鈕才能按 */
  acknowledge?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const bodyId = useId();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (acknowledge && !agreed) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
  };
  return (
    <Dialog
      title={title}
      alert
      width="sm"
      describedBy={body ? bodyId : undefined}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      {body && (
        <Markdown id={bodyId} className="scroll-panel max-h-[50vh] text-sm">
          {body}
        </Markdown>
      )}
      {acknowledge && (
        <Checkbox
          label={acknowledge}
          checked={agreed}
          autoFocus
          onChange={(e) => setAgreed(e.target.checked)}
        />
      )}
      <ErrorText message={error} />
      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="secondary"
          disabled={busy}
          autoFocus={tone === 'danger' && !acknowledge}
          onClick={onCancel}
        >
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          busy={busy}
          disabled={Boolean(acknowledge) && !agreed}
          autoFocus={tone === 'primary' && !acknowledge}
          onClick={() => void confirm()}
        >
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}

export type NoticeLevel = 'info' | 'success' | 'warning' | 'danger';

const LEVEL: Record<NoticeLevel, { ring: string; text: string; icon: string }> = {
  info: { ring: 'border-primary text-primary', text: 'text-primary', icon: 'i' },
  success: { ring: 'border-st-online text-st-online-text', text: 'text-st-online-text', icon: '✓' },
  warning: { ring: 'border-warning text-warning', text: 'text-warning', icon: '!' },
  danger: { ring: 'border-danger text-danger', text: 'text-danger', icon: '✕' },
};

export function NoticeDialog({
  level = 'info',
  title,
  body,
  actionLabel,
  secondary,
  onClose,
}: {
  level?: NoticeLevel;
  title: string;
  body?: string;
  actionLabel?: string;
  secondary?: { label: string; onClick: () => void };
  onClose: () => void;
}) {
  const bodyId = useId();
  const look = LEVEL[level];
  return (
    <Dialog
      label={`${t(`notice.level.${level}`)}：${title}`}
      alert={level === 'warning' || level === 'danger'}
      width="sm"
      describedBy={body ? bodyId : undefined}
      onClose={onClose}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-base font-bold ${look.ring}`}
        >
          {look.icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={`text-xs font-bold ${look.text}`}>{t(`notice.level.${level}`)}</span>
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
      </div>
      {body && (
        <Markdown id={bodyId} className="scroll-panel max-h-[50vh] text-sm">
          {body}
        </Markdown>
      )}
      <div className="flex justify-end gap-2 pt-2">
        {secondary && (
          <Button variant="secondary" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
        <Button autoFocus onClick={onClose}>
          {actionLabel ?? t('notice.ok')}
        </Button>
      </div>
    </Dialog>
  );
}

/** 不可逆動作的按鈕入口：點擊後開啟 `ConfirmDialog`（tone = danger）。 */
export function ConfirmButton({
  label,
  message,
  onConfirm,
  title,
  confirmLabel,
  size = 'sm',
}: {
  label: string;
  /** 說明（Markdown） */
  message: string;
  onConfirm: () => void | Promise<void>;
  /** 對話框標題；預設為按鈕文字 */
  title?: string;
  confirmLabel?: string;
  size?: 'sm' | 'md';
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button variant="danger" size={size} onClick={() => setAsking(true)}>
        {label}
      </Button>
      {asking && (
        <ConfirmDialog
          title={title ?? label}
          body={message}
          tone="danger"
          confirmLabel={confirmLabel ?? label}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            await onConfirm();
            setAsking(false);
          }}
        />
      )}
    </>
  );
}
