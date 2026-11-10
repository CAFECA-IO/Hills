/**
 * 任務執行紀錄與結案的純函式（technical-design §16.8 v0.29 / v0.33，D53）：誰能做什麼。
 */
import { isPrivateTask, type Task, type TaskLog, type TeamView } from './api';

/** 結案：任務未完成，且我是負責人（私人任務永遠是我）。 */
export const canClose = (t: Task, me: string) =>
  t.status !== 'done' && (isPrivateTask(t) || t.assignee === me);

/** 主按鈕是否為「結案」：可結案且沒有未完成的步驟（沒有步驟的任務也算）。 */
export const closeIsPrimary = (t: Task, me: string) =>
  canClose(t, me) && t.steps.every((s) => s.done);

/** 回報進度：負責人（私人任務是我）。 */
export const canReport = (t: Task, me: string) => isPrivateTask(t) || t.assignee === me;

/** 提出問題：負責人，私人任務不提供。 */
export const canAsk = (t: Task, me: string) => !isPrivateTask(t) && t.assignee === me;

/** 回覆問題：小組成員（看得到小組任務的人），私人任務不提供。 */
export const canAnswer = (t: Task) => !isPrivateTask(t);

/** 退回：已結案的小組任務；指派者、負責人或小組負責人。 */
export function canReopen(t: Task, me: string, teams: TeamView[]): boolean {
  if (isPrivateTask(t) || t.status !== 'done') return false;
  const leads = teams.find((x) => x.id === t.team)?.leads ?? [];
  return t.assignee === me || t.assignedBy === me || leads.includes(me);
}

/** 最後一筆結案紀錄之後是否被退回（顯示「已退回」標記）。 */
export function lastClose(logs: TaskLog[]): TaskLog | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (l?.kind === 'close') return l;
    if (l?.kind === 'reopen') return null;
  }
  return null;
}

/** 最新的進度百分比（沒有時 null）。 */
export function latestPercent(logs: TaskLog[]): number | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const p = logs[i]?.percent;
    if (p !== null && p !== undefined) return p;
  }
  return null;
}
