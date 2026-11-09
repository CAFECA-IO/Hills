/** AI 代理確認卡的摘要文字（ui-spec「AI 代理（MCP）」v0.25）。 */
import type { McpPreview, MemberView } from './api';
import { t } from './i18n';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

/** 確認卡上的一兩行摘要。 */
/** 核准鈕要用 danger 的變更：刪除、封存、會移出成員的小組變更。 */
export function isDangerous(p: McpPreview): boolean {
  return (
    p.action.startsWith('delete') ||
    p.action === 'archiveTeam' ||
    (p.action === 'updateTeam' && (p.removed?.length ?? 0) > 0)
  );
}

export function previewLines(p: McpPreview, members: MemberView[]): string[] {
  const name = (id?: string | null) => (id ? (members.find((m) => m.id === id)?.name ?? id) : null);
  const parts: string[] = [];
  switch (p.action) {
    case 'createTask':
    case 'updateTask':
    case 'deleteTask': {
      const who = name(p.assignee);
      if (p.title) parts.push(t('mcp.preview.title', { title: p.title }));
      if (who) parts.push(t('mcp.preview.assignee', { name: who }));
      if (p.dueAt) parts.push(t('mcp.preview.due', { date: day(p.dueAt) }));
      return [parts.join(' · ')];
    }
    case 'createGoal':
    case 'updateGoal':
    case 'deleteGoal':
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
    case 'message': {
      const peer = name(p.to);
      const head = peer
        ? t('mcp.preview.dm', { name: peer })
        : p.count
          ? t('mcp.preview.group', { conv: p.conv ?? '', count: p.count })
          : t('mcp.preview.to', { conv: p.conv ?? '' });
      return [head, p.text ?? ''];
    }
    case 'createTeamGoal':
    case 'updateTeamGoal':
    case 'deleteTeamGoal':
    case 'createDirection':
    case 'updateDirection':
    case 'deleteDirection':
      return [
        [p.team, p.period, p.title ? t('mcp.preview.title', { title: p.title }) : '']
          .filter(Boolean)
          .join(' · '),
      ];
    case 'weekNote':
      return [[p.team, p.period].filter(Boolean).join(' · '), p.text ?? ''];
    case 'taskStatus':
      return [
        [
          p.title ? t('mcp.preview.title', { title: p.title }) : '',
          p.status ? t('mcp.preview.status', { status: t(`mcp.status.${p.status}`) }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ];
    case 'taskAck':
      return [
        p.state === 'concern'
          ? t('mcp.preview.concern', { title: p.title ?? '', note: p.text ?? '' })
          : t('mcp.preview.accept', { title: p.title ?? '' }),
      ];
    case 'createTeam':
    case 'updateTeam': {
      const head = [
        p.action === 'updateTeam' ? p.team : null,
        p.action === 'updateTeam' && p.title && p.title !== p.team
          ? t('mcp.preview.rename', { name: p.title })
          : p.action === 'createTeam' && p.title
            ? t('mcp.preview.title', { title: p.title })
            : null,
        p.count != null ? t('mcp.preview.members', { count: p.count }) : null,
        p.leads?.length
          ? t('mcp.preview.leads', { names: p.leads.map((x) => name(x) ?? x).join('、') })
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const lines = [head];
      if (p.removed?.length)
        lines.push(
          t('mcp.preview.removed', { names: p.removed.map((x) => name(x) ?? x).join('、') }),
        );
      return lines;
    }
    case 'archiveTeam':
    case 'unarchiveTeam':
      return [p.team ?? ''];
    case 'createKbTopic':
      return [
        [
          p.title ? t('mcp.preview.title', { title: p.title }) : '',
          p.parent ? t('mcp.preview.inCategory', { name: p.parent }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ];
    case 'renameKb':
      return [t('mcp.preview.renameFrom', { from: p.from ?? '', title: p.title ?? '' })];
    default:
      return [p.title ? t('mcp.preview.title', { title: p.title }) : ''];
  }
}
