/**
 * 目標頁（ui-spec「目標」v0.21，D47）：預設為引導式，右上角「進階檢視」切換到路線圖。
 * 切換記在本機，同介面語言的做法。
 */
import { useState } from 'react';
import { GuidedGoals } from './goals-guided';
import { GoalsRoadmap, type GoalsProps } from './goals-roadmap';
import { t } from './i18n';
import { Switch } from './ui';

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

export function Goals(props: GoalsProps) {
  const [advanced, setAdvanced] = useState(readAdvanced);
  const toggle = (
    <Switch
      className="h-9 rounded-full bg-surface px-3 shadow-sm"
      label={t('guide.advanced')}
      checked={advanced}
      onChange={(on) => {
        setAdvanced(on);
        writeAdvanced(on);
      }}
    />
  );
  return advanced ? (
    <GoalsRoadmap {...props} headExtra={toggle} />
  ) : (
    <GuidedGoals
      {...props}
      toggle={toggle}
      onAdvanced={() => {
        setAdvanced(true);
        writeAdvanced(true);
      }}
    />
  );
}
