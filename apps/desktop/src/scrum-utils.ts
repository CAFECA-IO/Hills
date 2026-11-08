/** 每日 Scrum 的純函式（ui-spec「Scrum」、technical-design §16.12）。 */
import { isPrivateTask, type MemberView, type ScrumRef, type ScrumReport, type Task } from './api';
import { periodsAt } from './goals-utils';

/** `yyyy-mm-dd` 的星期（0 = 週日 … 6 = 週六）。 */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return t.toISOString().slice(0, 10);
}

/**
 * 工作日：第一版只排除週六、週日（technical-design §16.12）。
 * `holidays` / `workdays` 預留給假日曆（backlog #6）。
 */
export function isWorkday(date: string, holidays: string[] = [], workdays: string[] = []): boolean {
  if (workdays.includes(date)) return true;
  if (holidays.includes(date)) return false;
  const w = weekday(date);
  return w !== 0 && w !== 6;
}

/** 上一個工作日（週一 → 上週五）。 */
export function prevWorkday(date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 14 && !isWorkday(d); i++) d = addDays(d, -1);
  return d;
}

export function refKey(r: ScrumRef): string {
  switch (r.kind) {
    case 'task':
      return `task:${r.teamId}/${r.taskId}`;
    case 'plan':
      return `plan:${r.planId}`;
    case 'text':
      return `text:${r.title.trim()}`;
  }
}

/** 合併並去重（保留原有順序）。 */
export function mergeRefs(existing: ScrumRef[], add: ScrumRef[]): ScrumRef[] {
  const seen = new Set(existing.map(refKey));
  const out = [...existing];
  for (const r of add) {
    const k = refKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

const dayOf = (ms: number, tz: string) => periodsAt(ms, tz).day;

/** 任務的 Scrum 參照；私人任務只帶標題（小組讀者看不到私人任務，technical-design §16.12 v0.19）。 */
function taskRef(t: Task, title = t.title): ScrumRef {
  return isPrivateTask(t)
    ? { kind: 'text', title }
    : { kind: 'task', teamId: t.team, taskId: t.id, title };
}

/**
 * 「昨天完成」：從上一個工作日起（到今天）我完成的任務步驟與任務（D46 取消日目標）。
 */
export function doneSince(tasks: Task[], me: string, date: string, tz: string): ScrumRef[] {
  const since = prevWorkday(date);
  const inRange = (ms: number | null) => {
    if (ms === null) return false;
    const d = dayOf(ms, tz);
    return d >= since && d <= date;
  };
  const out: ScrumRef[] = [];
  for (const t of tasks) {
    const mySteps = t.steps.filter(
      (s) =>
        s.done &&
        (s.assignee === me || (isPrivateTask(t) && t.assignee === me)) &&
        inRange(s.doneAt),
    );
    if (mySteps.length > 0) {
      out.push(taskRef(t, `${t.title}：${mySteps.map((s) => s.title).join('、')}`));
    } else if (t.status === 'done' && t.assignee === me && inRange(t.updatedAt)) {
      out.push(taskRef(t));
    }
  }
  return out;
}

/** 「今天計劃」：焦點任務，以及今天到期或進行中的我的任務（D46）。 */
export function todayPlan(
  tasks: Task[],
  me: string,
  focusId: string | null,
  date: string,
  tz: string,
): ScrumRef[] {
  const out: ScrumRef[] = [];
  for (const t of tasks) {
    if (t.status === 'done') continue;
    const mine = t.assignee === me || t.steps.some((s) => !s.done && s.assignee === me);
    const dueToday = t.dueAt !== null && dayOf(t.dueAt, tz) === date;
    if (t.id === focusId || (mine && (dueToday || t.status === 'doing'))) {
      out.push(taskRef(t));
    }
  }
  return out;
}

export type MemberScrumStatus = 'submitted' | 'missing' | 'offday';

/** 小組總覽：每位成員當天的狀態。 */
export function teamStatus(
  members: MemberView[],
  reports: ScrumReport[],
  date: string,
): { member: MemberView; status: MemberScrumStatus; report: ScrumReport | null }[] {
  const work = isWorkday(date);
  return members.map((m) => {
    const report = reports.find((r) => r.member === m.id && r.date === date) ?? null;
    return {
      member: m,
      report,
      status: report ? 'submitted' : work ? 'missing' : 'offday',
    };
  });
}

/** 組織時區的現在時間 `HH:MM`。 */
export function clockIn(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || undefined,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(ms);
  }
}

/** 是否應提醒：工作日、已到提醒時間（尚未送出由 Rust 端再確認）。 */
export function shouldRemind(now: number, tz: string, reminder: string): boolean {
  const date = periodsAt(now, tz).day;
  return isWorkday(date) && clockIn(now, tz) >= reminder;
}
