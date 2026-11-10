/**
 * 目標頁（ui-spec「工作 › 目標」v0.42，D59）：「一條線 / 時間軸」切換（取代「進階檢視」開關），
 * 一條線為引導式、時間軸為路線圖；切換記在本機。
 */
import { useState } from 'react';
import { GuidedGoals } from './goals-guided';
import { GoalsRoadmap, type GoalsProps } from './goals-roadmap';
import { t } from './i18n';
import { SegmentedControl } from './ui';

const ADVANCED_KEY = 'hills.goals.advanced';

function readAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAdvanced(on: boolean) {
  try {
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0');
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
  const [advanced, setAdvanced] = useState(readAdvanced);
  const set = (on: boolean) => {
    setAdvanced(on);
    writeAdvanced(on);
  };
  const toggle = (
    <SegmentedControl
      label={t('goals.view.label')}
      options={[
        { value: 'line', label: t('goals.view.line') },
        { value: 'timeline', label: t('goals.view.timeline') },
      ]}
      value={advanced ? 'timeline' : 'line'}
      onChange={(v) => set(v === 'timeline')}
    />
  );
  return advanced && scope !== 'team' ? (
    <GoalsRoadmap {...props} headExtra={toggle} />
  ) : (
    <GuidedGoals
      {...props}
      toggle={scope === 'team' ? null : toggle}
      noAutoWeekly={noAutoWeekly}
      scope={scope}
      onAdvanced={() => set(true)}
    />
  );
}
