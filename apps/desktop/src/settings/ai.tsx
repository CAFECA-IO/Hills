/** 設定 › AI 協助（ui-spec「設定」v0.37；D48；文件理解 v0.49，D68）。 */
import { useEffect } from 'react';
import type { AppInfo } from '../api';
import { McpOrgCard, McpPersonalCard } from '../mcp-settings';
import { DocAiCard } from '../settings-docai';
import { writeFlag } from './model';

export function AiGroup({ info }: { info: AppInfo }) {
  // 管理者看過這一頁就算已決定（營地進度，D56）
  useEffect(() => {
    if (info.isAdmin) writeFlag('ai');
  }, [info.isAdmin]);
  return (
    <div id="settings-mcp" className="flex flex-col gap-4">
      {info.isAdmin && <McpOrgCard />}
      <McpPersonalCard />
      <DocAiCard />
    </div>
  );
}
