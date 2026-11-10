/**
 * OGSM 的純函式（ui-spec「工作 › 我的位置與 OGSM」v0.44，D65；technical-design §16.14 v0.35）：
 * 期間應到的進度、我的角色、時間花在專案的比例、往山丘走的狀態。
 */
import type {
  DayLog,
  DirectionsView,
  PlanView,
  Purpose,
  StrategyView,
  Task,
  TeamGoal,
  TeamView,
} from './api';
import type { Assessment } from './drift-utils';

const DAY = 86_400_000;

/**
 * 期間經過的比例（0–1）：`2026`、`2026–2027`（或 `2026-2027`）以年計；其他格式回傳 null。
 * `today` 為組織時區的 `YYYY-MM-DD`。
 */
export function elapsedOf(period: string, today: string): number | null {
  const m = /^(\d{4})(?:\s*[–-]\s*(\d{4}))?$/.exec(period.trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  if (to < from) return null;
  const [y, mo, d] = today.split('-').map(Number) as [number, number, number];
  const start = Date.UTC(from, 0, 1);
  const end = Date.UTC(to + 1, 0, 1);
  const now = Date.UTC(y, mo - 1, d) + DAY / 2;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

export interface MyRole {
  /** 我所屬的小組 */
  teams: TeamView[];
  /** 各小組的目的 */
  purposes: Purpose[];
  /** 我所屬小組的策略 */
  strategies: StrategyView[];
  /** 我負責的策略（owners 含我） */
  owned: StrategyView[];
  /** 我所屬小組的小組目標 */
  teamGoals: TeamGoal[];
  /** 我的年 / 季目標中對齊公司或小組目標的 */
  aligned: PlanView[];
  /** 我的年 / 季目標總數（本年度） */
  myGoals: number;
  /** 這週連到小組目標的我的任務數 */
  weekTasks: number;
}

/** 從 OGSM 與我的目標、任務推出「我的角色」（只在本人的裝置計算）。 */
export function myRole(
  view: DirectionsView,
  teams: TeamView[],
  plans: PlanView[],
  tasks: Task[],
  me: string,
  year: string,
  thisWeekGoals: Set<string>,
): MyRole {
  const mine = teams.filter((t) => t.members.includes(me) || t.leads.includes(me));
  const teamIds = new Set(mine.map((t) => t.id));
  const teamGoals = view.teamGoals.filter((g) => teamIds.has(g.team));
  const strategies = (view.strategies ?? []).filter((s) => teamIds.has(s.team));
  const alignable = new Set([...view.directions.map((d) => d.id), ...teamGoals.map((g) => g.id)]);
  const myYearQuarter = plans.filter(
    (p) => p.mine && (p.level === 'year' || p.level === 'quarter') && p.period.startsWith(year),
  );
  const weekTasks = tasks.filter(
    (t) =>
      t.status !== 'done' &&
      t.assignee === me &&
      ((t.planItemId !== null && thisWeekGoals.has(t.planItemId)) ||
        (t.teamGoalId !== null && teamGoals.some((g) => g.id === t.teamGoalId))),
  ).length;
  return {
    teams: mine,
    purposes: (view.teamPurposes ?? []).filter((p) => p.team && teamIds.has(p.team)),
    strategies,
    owned: strategies.filter((s) => s.owners.includes(me)),
    teamGoals,
    aligned: myYearQuarter.filter((p) => p.alignedGoalId && alignable.has(p.alignedGoalId)),
    myGoals: myYearQuarter.length,
    weekTasks,
  };
}

/** 本週連到小組目標（專案）的時間比例（0–100）；沒有紀錄時 null。只有本人的 worklog（D62）。 */
export function projectShare(days: DayLog[], weekDays: string[]): number | null {
  const set = new Set(weekDays);
  let total = 0;
  let project = 0;
  for (const d of days) {
    if (!set.has(d.date)) continue;
    for (const e of d.entries) {
      total += e.minutes;
      if (e.project) project += e.minutes;
    }
  }
  return total > 0 ? Math.round((project / total) * 100) : null;
}

export type HillState = 'onTrack' | 'slow' | 'veered' | 'stopped' | 'unknown';

/** 四項檢查 → 往山丘走的狀態（「往後退」由小組畫面計算，這裡不判斷）。 */
export function hillStateOf(a: Assessment): HillState {
  if (a.state === 'unknown') return 'unknown';
  if (a.state === 'stale') return 'stopped';
  if (a.unaligned || a.elsewhere) return 'veered';
  if (a.behind) return 'slow';
  return 'onTrack';
}
