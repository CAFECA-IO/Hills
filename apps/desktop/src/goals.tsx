/**
 * 目標頁（ui-spec「目標」v0.19，D47）：預設為引導式，右上角「進階檢視」切換到階梯
 * （第 3 批改為路線圖）。切換記在本機，同介面語言的做法。
 */
import { useState } from 'react';
import { GuidedGoals } from './goals-guided';
import { GoalsLadder, type GoalsProps } from './goals-ladder';
import { t } from './i18n';
import { Checkbox } from './ui';

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
    <Checkbox
      className="h-9 rounded-full bg-surface px-3 shadow-sm"
      label={t('guide.advanced')}
      checked={advanced}
      onChange={(e) => {
        setAdvanced(e.target.checked);
        writeAdvanced(e.target.checked);
      }}
    />
  );
  return advanced ? (
    <GoalsLadder {...props} headExtra={toggle} />
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
