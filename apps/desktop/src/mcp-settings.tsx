/**
 * 本機 MCP 介面的設定（ui-spec「AI 代理（MCP）」v0.25，feature-plan D48，technical-design §18）：
 * 組織開關（管理者）與個人裝置的開關、端點、token、連線方式、最近的請求。
 */
import { useEffect, useRef, useState } from 'react';
import { api, EVENTS, listen, type McpAuditEntry, type McpSettings } from './api';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import {
  Button,
  Card,
  ConfirmButton,
  ConfirmDialog,
  ErrorText,
  SectionLabel,
  Switch,
  useAction,
} from './ui';

/** 設定或待確認變更改變時呼叫（訂閱 `hills://mcp`）。 */
export function useMcpEvents(onEvent: () => void) {
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  });
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void listen<string>(EVENTS.mcp, () => cb.current()).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
}

function useMcpSettings() {
  const s = useLoad(api.mcpSettings, ['org']);
  const audit = useLoad(api.mcpAudit, []);
  useMcpEvents(() => {
    s.reload();
    audit.reload();
  });
  return { s, audit };
}

/** 一行可複製的文字。 */
function CopyLine({
  label,
  value,
  mask = false,
}: {
  label: string;
  value: string;
  mask?: boolean;
}) {
  const [shown, setShown] = useState(!mask);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪貼簿不可用時使用者可手動選取
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-control border border-line bg-bg px-3 py-2 text-xs select-all">
          {shown ? value : '•'.repeat(24)}
        </code>
        {mask && (
          <Button variant="ghost" size="sm" onClick={() => setShown((x) => !x)}>
            {shown ? t('mcp.hide') : t('mcp.show')}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

const OUTCOME: Record<McpAuditEntry['outcome'], MessageKey> = {
  read: 'mcp.outcome.read',
  pending: 'mcp.outcome.pending',
  approved: 'mcp.outcome.approved',
  rejected: 'mcp.outcome.rejected',
  denied: 'mcp.outcome.denied',
  error: 'mcp.outcome.error',
};

function Connect({ s }: { s: McpSettings }) {
  const token = s.token ?? '';
  const claudeCode = `claude mcp add --transport http hills ${s.endpoint} --header "Authorization: Bearer ${token}"`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        hills: {
          command: 'npx',
          args: ['mcp-remote', s.endpoint, '--header', `Authorization: Bearer ${token}`],
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-bold">{t('mcp.connect')}</h3>
      <CopyLine label={t('mcp.connect.code')} value={claudeCode} mask />
      <CopyLine label={t('mcp.connect.desktop')} value={desktop} mask />
    </div>
  );
}

/** 設定 → 個人 → AI 代理（MCP）。 */
export function McpPersonalCard() {
  const { s, audit } = useMcpSettings();
  const { error, attempt } = useAction();
  const [asking, setAsking] = useState(false);
  const data = s.data;
  if (!data) return null;
  const set = (on: boolean) =>
    void attempt(async () => {
      await api.setMcpEnabled(on);
      s.reload();
    });
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{t('mcp.title')}</h2>
        <p className="text-sm text-muted">{t('mcp.intro')}</p>
      </div>
      {!data.allowed ? (
        <p className="text-sm text-muted">{t('mcp.notAllowed')}</p>
      ) : (
        <>
          <Switch
            checked={data.enabled}
            onChange={(on) => (on ? setAsking(true) : set(false))}
            label={t('mcp.enable')}
            description={
              data.enabled
                ? data.running
                  ? t('mcp.running', { endpoint: data.endpoint })
                  : t('mcp.notRunning')
                : t('mcp.enableHint')
            }
          />
          {data.error && <ErrorText message={t('mcp.bindError', { error: data.error })} />}
          {data.enabled && data.token && (
            <>
              <CopyLine label={t('mcp.endpoint')} value={data.endpoint} />
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <CopyLine label={t('mcp.token')} value={data.token} mask />
                </div>
                <ConfirmButton
                  label={t('mcp.regenerate')}
                  message={t('mcp.regenerate.confirm')}
                  onConfirm={() =>
                    void attempt(async () => {
                      await api.regenerateMcpToken();
                      s.reload();
                    })
                  }
                />
              </div>
              <Connect s={data} />
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-bold">{t('mcp.audit')}</h3>
            {(audit.data ?? []).length === 0 ? (
              <p className="text-xs text-muted">{t('mcp.audit.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line text-xs">
                {(audit.data ?? []).map((a, i) => (
                  <li key={`${a.at}-${i}`} className="flex gap-3 py-1.5">
                    <span className="w-24 shrink-0 text-muted">
                      {new Date(a.at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="w-28 shrink-0 truncate">{a.client}</span>
                    <code className="min-w-0 flex-1 truncate">{a.tool}</code>
                    <span
                      className={
                        a.outcome === 'denied' || a.outcome === 'error'
                          ? 'text-warning'
                          : 'text-muted'
                      }
                    >
                      {t(OUTCOME[a.outcome])}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <ErrorText message={error} />
      {asking && (
        <ConfirmDialog
          title={t('mcp.warn.title')}
          body={[
            t('mcp.warn.body'),
            '',
            `- ${t('mcp.warn.point1')}`,
            `- ${t('mcp.warn.point2')}`,
            `- ${t('mcp.warn.point3')}`,
          ].join('\n')}
          acknowledge={t('mcp.warn.agree')}
          confirmLabel={t('mcp.warn.ok')}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            set(true);
          }}
        />
      )}
    </Card>
  );
}

/** 設定 → 組織：允許成員使用 AI 代理（管理者）。 */
export function McpOrgCard() {
  const { s } = useMcpSettings();
  const { error, attempt } = useAction();
  if (!s.data) return null;
  return (
    <Card className="flex flex-col gap-2">
      <Switch
        checked={s.data.allowed}
        onChange={(on) =>
          void attempt(async () => {
            await api.setMcpAllowed(on);
            s.reload();
          })
        }
        label={t('mcp.org.allow')}
        description={t('mcp.org.hint')}
      />
      <ErrorText message={error} />
    </Card>
  );
}
