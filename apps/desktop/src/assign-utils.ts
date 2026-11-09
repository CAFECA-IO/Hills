/** 組長分派任務（ui-spec「任務 → 分派」，D50；technical-design §16.8 v0.26）的純函式。 */
import type { Task, TaskInput, TeamView } from './api';
import { periodsAt } from './goals-utils';

/** 「偏重」門檻（D50：固定值，之後可改為組織設定）。 */
export const HEAVY_OPEN = 7;
export const HEAVY_DUE = 4;

export interface Load {
  /** 負責、未完成的任務數 */
  open: number;
  /** 其中期限在本週以前（含已逾期） */
  dueThisWeek: number;
  heavy: boolean;
}

const EMPTY: Load = { open: 0, dueThisWeek: 0, heavy: false };

function withHeavy(open: number, dueThisWeek: number): Load {
  return { open, dueThisWeek, heavy: open >= HEAVY_OPEN || dueThisWeek >= HEAVY_DUE };
}

/** 每位成員的負荷（只算看得到的小組任務與私人任務）。 */
export function loads(
  tasks: Pick<Task, 'assignee' | 'status' | 'dueAt'>[],
  thisWeek: string,
  tz: string,
): Record<string, Load> {
  const acc: Record<string, { open: number; due: number }> = {};
  for (const t of tasks) {
    if (!t.assignee || t.status === 'done') continue;
    const a = (acc[t.assignee] ??= { open: 0, due: 0 });
    a.open += 1;
    if (t.dueAt != null && periodsAt(t.dueAt, tz).week <= thisWeek) a.due += 1;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, withHeavy(v.open, v.due)]));
}

export function loadOf(all: Record<string, Load>, member: string): Load {
  return all[member] ?? EMPTY;
}

/** 加上這次要建立的任務後的負荷。 */
export function addRows(
  base: Record<string, Load>,
  rows: Pick<DraftRow, 'assignee' | 'dueAt' | 'title'>[],
  thisWeek: string,
  tz: string,
): Record<string, Load> {
  const out: Record<string, Load> = { ...base };
  for (const r of rows) {
    if (!r.assignee || !r.title.trim()) continue;
    const cur = loadOf(out, r.assignee);
    const due = r.dueAt != null && periodsAt(r.dueAt, tz).week <= thisWeek ? 1 : 0;
    out[r.assignee] = withHeavy(cur.open + 1, cur.dueThisWeek + due);
  }
  return out;
}

/** 依「本週到期 → 未完成 → 姓名」排序，負荷輕的在前。 */
export function sortByLoad<M extends { id: string; name: string }>(
  members: M[],
  all: Record<string, Load>,
): M[] {
  return [...members].sort((a, b) => {
    const la = loadOf(all, a.id);
    const lb = loadOf(all, b.id);
    return la.dueThisWeek - lb.dueThisWeek || la.open - lb.open || a.name.localeCompare(b.name);
  });
}

/** 分派板的欄位：未指派與每位成員未完成的任務（期限近的在前）。 */
export function boardColumns(tasks: Task[], team: TeamView) {
  const open = tasks
    .filter((t) => t.team === team.id && t.status !== 'done')
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  const people = [...new Set([...team.members, ...team.leads])];
  const byMember: Record<string, Task[]> = Object.fromEntries(people.map((m) => [m, []]));
  const unassigned: Task[] = [];
  for (const t of open) {
    const list = t.assignee ? byMember[t.assignee] : undefined;
    if (list) list.push(t);
    else unassigned.push(t);
  }
  return { people, unassigned, byMember };
}

/** 只有該小組負責人與管理者可以指派（ui-spec「任務 → 分派」）。 */
export function canAssign(team: TeamView, me: string | null, isAdmin: boolean): boolean {
  return isAdmin || (me != null && team.leads.includes(me));
}

export interface DraftRow {
  title: string;
  assignee: string | null;
  dueAt: number | null;
}

/** 貼上的多行文字 → 一行一件（去掉項目符號與編號）。 */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
}

/** 要建立的列：有標題者。 */
export function rowsToCreate(rows: DraftRow[]): DraftRow[] {
  return rows.filter((r) => r.title.trim()).map((r) => ({ ...r, title: r.title.trim() }));
}

/** 我負責、等我回應的任務（首頁「新指派給你」）。 */
export function assignedToMe(tasks: Task[], me: string | null): Task[] {
  if (!me) return [];
  return tasks
    .filter((t) => t.assignee === me && t.pendingAck)
    .sort((a, b) => (b.assignedAt ?? 0) - (a.assignedAt ?? 0));
}

/**
 * 由現有任務組出更新輸入（保留其他欄位）。改派給別人時清掉週目標：
 * 週目標屬於原負責人，新負責人接下時再選。
 */
export function inputOf(task: Task, patch: Partial<TaskInput> = {}): TaskInput {
  const base: TaskInput = {
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    dueAt: task.dueAt,
    steps: task.steps.map((s) => ({
      id: s.id,
      title: s.title,
      assignee: s.assignee,
      done: s.done,
    })),
    planItemId: task.planItemId,
    teamGoalId: task.teamGoalId,
  };
  const next = { ...base, ...patch };
  if ('assignee' in patch && patch.assignee !== task.assignee && !('planItemId' in patch)) {
    next.planItemId = null;
  }
  return next;
}
