/** AI 代理確認卡的摘要文字（ui-spec「AI 代理（MCP）」v0.25）。 */
import type { McpPreview, MemberView } from './api';
import { t } from './i18n';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

/** 確認卡上的一兩行摘要。 */
export function previewLines(p: McpPreview, members: MemberView[]): string[] {
  const name = (id?: string | null) => (id ? (members.find((m) => m.id === id)?.name ?? id) : null);
  const parts: string[] = [];
  switch (p.action) {
    case 'createTask':
    case 'updateTask': {
      const who = name(p.assignee);
      if (p.title) parts.push(t('mcp.preview.title', { title: p.title }));
      if (who) parts.push(t('mcp.preview.assignee', { name: who }));
      if (p.dueAt) parts.push(t('mcp.preview.due', { date: day(p.dueAt) }));
      return [parts.join(' · ')];
    }
    case 'createGoal':
    case 'updateGoal':
      return [
        [p.period, p.title ? t('mcp.preview.title', { title: p.title }) : '']
          .filter(Boolean)
          .join(' · '),
      ];
    case 'stepDone':
      return [
        t(p.done ? 'mcp.preview.stepDone' : 'mcp.preview.stepUndone', {
          task: p.task ?? '',
          step: p.step ?? '',
        }),
      ];
    case 'scrumDraft':
      return [p.date ?? '', p.text ?? ''];
    case 'message':
      return [t('mcp.preview.to', { conv: p.conv ?? '' }), p.text ?? ''];
    default:
      return [p.title ? t('mcp.preview.title', { title: p.title }) : ''];
  }
}
