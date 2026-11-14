/**
 * 目標頁（ui-spec「工作 › 目標」v0.44，D59、D65）：「我的位置 · OGSM · 時間軸」切換，記在本機。
 * 我的位置 = 四個問題卡 ＋ 引導式的一條線；OGSM = 公司 / 小組的一頁 OGSM；時間軸 = 路線圖。
 */
import { useState } from 'react';
import { GuidedGoals } from './goals-guided';
import { GoalsRoadmap, type GoalsProps } from './goals-roadmap';
import { t } from './i18n';
import { OgsmPage, OgsmPosition } from './ogsm';
import { ExportButton } from './report-export';
import { SegmentedControl } from './ui';

const VIEW_KEY = 'hills.goals.view';
/** v0.42 的「時間軸」開關 */
const ADVANCED_KEY = 'hills.goals.advanced';

export type View = 'position' | 'ogsm' | 'timeline';

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'position' || v === 'ogsm' || v === 'timeline') return v;
    return localStorage.getItem(ADVANCED_KEY) === '1' ? 'timeline' : 'position';
  } catch {
    return 'position';
  }
}

export function writeView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // 忽略：只影響下次開啟
  }
}

export interface GoalsPageProps extends GoalsProps {
  /** 在「工作」裡：週一方向時刻不再自動開啟（改由「這週」提示列，D59） */
  noAutoWeekly?: boolean;
  /** 固定範圍（「工作 › 小組 › 方向」用 team），不顯示範圍切換 */
  scope?: 'mine' | 'team';
}

export function Goals({ noAutoWeekly, scope, ...props }: GoalsPageProps) {
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => {
    setViewState(v);
    writeView(v);
  };
  // 目標頁的匯出帶入月報（ui-spec v0.45）
  const exportButton = (
    <ExportButton
      label={t('exp.open')}
      initialKind="monthly"
      members={props.members}
      teams={props.teams}
      tasks={props.tasks}
      timezone={props.timezone}
    />
  );
  const segmented = (
    <SegmentedControl
      label={t('goals.view.label')}
      options={[
        { value: 'position', label: t('goals.view.position') },
        { value: 'ogsm', label: t('goals.view.ogsm') },
        { value: 'timeline', label: t('goals.view.timeline') },
      ]}
      value={view}
      onChange={setView}
    />
  );
  const toggle = (
    <span className="flex items-center gap-2">
      {view !== 'ogsm' && exportButton}
      {segmented}
    </span>
  );
  if (scope !== 'team' && view === 'timeline')
    return <GoalsRoadmap {...props} headExtra={toggle} onPlan={() => setView('position')} />;
  if (scope !== 'team' && view === 'ogsm')
    return (
      <OgsmPage
        members={props.members}
        teams={props.teams}
        timezone={props.timezone}
        headExtra={toggle}
      />
    );
  return (
    <GuidedGoals
      {...props}
      toggle={scope === 'team' ? null : toggle}
      noAutoWeekly={noAutoWeekly}
      scope={scope}
      onAdvanced={() => setView('timeline')}
      header={
        scope === 'team' ? undefined : (
          <OgsmPosition
            members={props.members}
            teams={props.teams}
            tasks={props.tasks}
            timezone={props.timezone}
            onOgsm={() => setView('ogsm')}
          />
        )
      }
    />
  );
}
