/**
 * 「工作」的純函式（ui-spec「工作」v0.42，D59、D62；technical-design §16.18）：
 * 專案歸屬、計時片段整理成逐筆時間、週計劃快照、今天要做的清單。
 */
import {
  isPrivateTask,
  type PlanView,
  type Task,
  type TimerSegment,
  type WeekPlan,
  type WorkEntry,
  type WorkRef,
} from './api';
import { periodsAt } from './goals-utils';
import { daysOf } from './reports-utils';

/** 某時區某時刻與 UTC 的差（ms）。 */
export function tzOffset(ms: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(ms);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      n('year'),
      n('month') - 1,
      n('day'),
      n('hour'),
      n('minute'),
      n('second'),
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** 某時區某日 00:00 的時間。 */
export function dayStartIn(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - tzOffset(guess, tz);
}

export function refKey(r: WorkRef): string {
  switch (r.kind) {
    case 'task':
      return `task:${r.team}/${r.task}`;
    case 'meeting':
      return 'meeting';
    case 'other':
      return `other:${r.title}`;
  }
}

/** 任務屬於哪個專案（小組目標，D61）：週目標往上找對齊的小組目標，沒有時用任務的來源小組目標。 */
export function projectOf(
  task: Pick<Task, 'planItemId' | 'teamGoalId'>,
  plans: PlanView[],
  teamGoalIds: Set<string>,
): string | null {
  const byId = new Map(plans.map((p) => [p.id, p]));
  let p = task.planItemId ? byId.get(task.planItemId) : undefined;
  for (let i = 0; p && i < 6; i++) {
    if (p.alignedGoalId && teamGoalIds.has(p.alignedGoalId)) return p.alignedGoalId;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return task.teamGoalId && teamGoalIds.has(task.teamGoalId) ? task.teamGoalId : null;
}

export const round15 = (minutes: number) => Math.round(minutes / 15) * 15;

/**
 * 某天的計時片段 → 逐筆時間（technical-design §16.18「整理」）：依項目加總、四捨五入到 15 分鐘；
 * `workMinutes` 為當天工作時段的分鐘數，有剩下時補一筆「訊息與零碎」。
 */
export function entriesFromSegments(
  segments: TimerSegment[],
  date: string,
  tz: string,
  project: (r: WorkRef) => string | null,
  workMinutes: number,
  otherTitle: string,
): WorkEntry[] {
  const start = dayStartIn(date, tz);
  const end = start + 86_400_000;
  const sum = new Map<string, { ref: WorkRef; ms: number }>();
  for (const s of segments) {
    const ms = Math.min(s.end, end) - Math.max(s.start, start);
    if (ms <= 0) continue;
    const k = refKey(s.ref);
    const cur = sum.get(k) ?? { ref: s.ref, ms: 0 };
    cur.ms += ms;
    sum.set(k, cur);
  }
  const out: WorkEntry[] = [];
  for (const { ref, ms } of sum.values()) {
    const minutes = round15(ms / 60_000);
    if (minutes === 0) continue;
    out.push({ ref, project: project(ref), minutes, source: 'auto' });
  }
  const used = out.reduce((n, e) => n + e.minutes, 0);
  const rest = round15(workMinutes - used);
  if (out.length > 0 && rest > 0) {
    out.push({
      ref: { kind: 'other', title: otherTitle },
      project: null,
      minutes: rest,
      source: 'auto',
    });
  }
  return out;
}

/** 工作時段的分鐘數（扣午休 60 分鐘；不是工作日時 0）。 */
export function workMinutesOf(
  date: string,
  hours: { days: number[]; start: string; end: string } | null | undefined,
): number {
  const h = hours ?? { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay() || 7;
  if (!h.days.includes(dow)) return 0;
  const mins = (s: string) => {
    const [hh, mm] = s.split(':').map(Number);
    return (hh ?? 0) * 60 + (mm ?? 0);
  };
  const len = mins(h.end) - mins(h.start);
  return Math.max(0, len > 300 ? len - 60 : len);
}

export const taskRef = (t: Task, step?: { id: string; title: string } | null): WorkRef => ({
  kind: 'task',
  team: t.team,
  task: t.id,
  step: step?.id ?? null,
  title: step ? `${t.title}：${step.title}` : t.title,
});

/** 週計劃快照（D62）：我負責、未完成，期限在這週或連到這週的週目標。 */
export function weekPlanFrom(
  tasks: Task[],
  me: string,
  week: string,
  tz: string,
  plans: PlanView[],
  teamGoalIds: Set<string>,
  capacity: number,
): WeekPlan {
  const days = new Set(daysOf('weekly', week));
  const goals = new Set(
    plans.filter((p) => p.level === 'week' && p.period === week).map((p) => p.id),
  );
  const list = tasks.filter(
    (x) =>
      x.status !== 'done' &&
      (x.assignee === me || isPrivateTask(x)) &&
      ((x.dueAt !== null && days.has(periodsAt(x.dueAt, tz).day)) ||
        (x.planItemId !== null && goals.has(x.planItemId))),
  );
  return {
    week,
    capacity,
    createdAt: 0,
    tasks: list.map((x) => ({
      ref: taskRef(x),
      estimate: x.estimate ?? null,
      project: projectOf(x, plans, teamGoalIds),
    })),
  };
}

/** 今天要做（ui-spec「工作 › 今天」）：我的未完成任務中，過期、今天到期、焦點、進行中或卡住的；過期在最上面。 */
export function todayList(
  tasks: Task[],
  me: string,
  focusId: string | null,
  today: string,
  tz: string,
): Task[] {
  const mine = (x: Task) =>
    x.assignee === me || isPrivateTask(x) || x.steps.some((s) => !s.done && s.assignee === me);
  const dayOf = (ms: number | null) => (ms === null ? null : periodsAt(ms, tz).day);
  const list = tasks.filter((x) => {
    if (x.status === 'done' || !mine(x)) return false;
    const due = dayOf(x.dueAt);
    return (
      x.id === focusId ||
      (due !== null && due <= today) ||
      x.status === 'doing' ||
      Boolean(x.blocked)
    );
  });
  return list.sort((a, b) => {
    const da = dayOf(a.dueAt) ?? '9999';
    const db = dayOf(b.dueAt) ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    return (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });
}

/** 計時中的秒數格式 `h:mm:ss`。 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 分鐘數 `h:mm`。 */
export const hm = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`;
