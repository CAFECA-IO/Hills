/**
 * AI 代理確認卡（ui-spec「AI 代理（MCP）」v0.25，D17 / D48）：外部 Agent 的修改在這裡核准才寫入。
 */
import { useState } from 'react';
import { api, type McpChange, type McpPreview, type MemberView } from './api';
import { previewLines } from './mcp-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { useMcpEvents } from './mcp-settings';
import { Button, ErrorText, LinkButton, useAction } from './ui';

const ACTION: Record<McpPreview['action'], MessageKey> = {
  createGoal: 'mcp.action.createGoal',
  updateGoal: 'mcp.action.updateGoal',
  createTask: 'mcp.action.createTask',
  updateTask: 'mcp.action.updateTask',
  stepDone: 'mcp.action.stepDone',
  scrumDraft: 'mcp.action.scrumDraft',
  message: 'mcp.action.message',
  createKb: 'mcp.action.createKb',
  updateKb: 'mcp.action.updateKb',
  deleteGoal: 'mcp.action.deleteGoal',
  deleteTask: 'mcp.action.deleteTask',
  deleteKb: 'mcp.action.deleteKb',
};

function ChangeCard({ c, members }: { c: McpChange; members: MemberView[] }) {
  const { busy, error, attempt } = useAction();
  return (
    <section
      aria-label={t('mcp.card.label', { client: c.client })}
      className="flex w-90 flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-md"
    >
      <span className="text-xs text-muted">{t('mcp.card.wants', { client: c.client })}</span>
      <span className="text-sm font-bold">{t(ACTION[c.preview.action])}</span>
      {previewLines(c.preview, members)
        .filter(Boolean)
        .map((line, i) => (
          <p key={i} className={`text-sm ${i > 0 ? 'line-clamp-3 text-muted' : ''}`}>
            {line}
          </p>
        ))}
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void attempt(() => api.mcpReject(c.id))}
        >
          {t('mcp.reject')}
        </Button>
        <Button
          size="sm"
          variant={c.preview.action.startsWith('delete') ? 'danger' : 'primary'}
          busy={busy}
          onClick={() => void attempt(() => api.mcpApprove(c.id))}
        >
          {t('mcp.approve')}
        </Button>
      </div>
    </section>
  );
}

/** shell 右下的確認卡堆疊；超過 3 張時摺疊。 */
export function McpConfirmStack({ members }: { members: MemberView[] }) {
  const pending = useLoad(api.mcpPending, []);
  useMcpEvents(() => pending.reload());
  const [open, setOpen] = useState(false);
  const list = pending.data ?? [];
  if (list.length === 0) return null;
  const shown = open ? list : list.slice(0, 3);
  return (
    <div className="pointer-events-none fixed right-4 bottom-16 z-30 flex flex-col items-end gap-2">
      {shown.map((c) => (
        <div key={c.id} className="pointer-events-auto">
          <ChangeCard c={c} members={members} />
        </div>
      ))}
      {list.length > 3 && (
        <div className="pointer-events-auto rounded-full bg-surface px-3 py-1 shadow-sm">
          <LinkButton className="text-xs" onClick={() => setOpen((x) => !x)}>
            {open ? t('mcp.collapse') : t('mcp.more', { n: list.length - 3 })}
          </LinkButton>
        </div>
      )}
    </div>
  );
}
