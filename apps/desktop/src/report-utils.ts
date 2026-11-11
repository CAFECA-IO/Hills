/**
 * 報告六段的計算（ui-spec「工作 › 報告與匯出」v0.42，D61；technical-design §16.13 v0.34）：
 * 期間、時間花在哪裡、專案推進、實際 vs 計劃、偏離原因、摘要句型、Markdown / CSV。
 * 全部在本機計算，不經外部服務。
 */
import type {
  DayLog,
  DirectionWeek,
  MyLog,
  PlanMinutes,
  ProjectRow,
  Reason,
  ReportData,
  Task,
  TeamGoal,
  TimeRow,
  WeekPlan,
} from './api';
import { periodsAt, periodsOfYmd } from './goals-utils';
import { daysOf as weekDays, mondayOf } from './reports-utils';
import { addDays } from './scrum-utils';

export type PeriodKind = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export const PERIOD_KINDS: PeriodKind[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

/** `other` = 沒連到小組目標的任務；`nontask` = 會議、訊息與零碎。 */
export const OTHER = 'other';
export const NONTASK = 'nontask';

const ymd = (d: string) => d.split('-').map(Number) as [number, number, number];
const pad = (n: number) => String(n).padStart(2, '0');

/** 某日所在的期間代碼：日 `2026-11-11`、週 `2026-W46`、月 `2026-11`、季 `2026-Q4`、年 `2026`。 */
export function periodOfDay(kind: PeriodKind, day: string): string {
  const [y, m, d] = ymd(day);
  switch (kind) {
    case 'daily':
      return day;
    case 'weekly':
      return periodsOfYmd(y, m, d).week;
    case 'monthly':
      return `${y}-${pad(m)}`;
    case 'quarterly':
      return `${y}-Q${Math.ceil(m / 3)}`;
    case 'yearly':
      return String(y);
  }
}

function monthDays(y: number, m: number): string[] {
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
}

/** 期間內的日期（舊 → 新）。 */
export function periodDays(kind: PeriodKind, period: string): string[] {
  switch (kind) {
    case 'daily':
      return [period];
    case 'weekly':
      return weekDays('weekly', period);
    case 'monthly': {
      const [y, m] = period.split('-').map(Number) as [number, number];
      return monthDays(y, m);
    }
    case 'quarterly': {
      const [ys, qs] = period.split('-Q');
      const y = Number(ys);
      const q = Number(qs);
      return [1, 2, 3].flatMap((k) => monthDays(y, (q - 1) * 3 + k));
    }
    case 'yearly':
      return Array.from({ length: 12 }, (_, i) => monthDays(Number(period), i + 1)).flat();
  }
}

/** 上 / 下 n 期。 */
export function shiftKindPeriod(kind: PeriodKind, period: string, n: number): string {
  if (kind === 'daily') return addDays(period, n);
  if (kind === 'weekly') return periodOfDay('weekly', addDays(mondayOf(period), 7 * n));
  let p = period;
  for (let k = 0; k < Math.abs(n); k++) {
    const days = periodDays(kind, p);
    p = periodOfDay(kind, n >= 0 ? addDays(days[days.length - 1]!, 1) : addDays(days[0]!, -1));
  }
  return p;
}

/** 期間涵蓋的 ISO 週（週計劃快照、週報用）。 */
export function weeksOf(days: string[]): string[] {
  return [...new Set(days.map((d) => periodOfDay('weekly', d)))];
}

/** 期間涵蓋的月份（worklog 文件分份用）；週以週一所在月份為準，所以往前多取一個月。 */
export function monthsOf(days: string[]): string[] {
  const first = days[0]!;
  const prev = periodOfDay('monthly', addDays(first, -7));
  return [...new Set([prev, ...days.map((d) => d.slice(0, 7))])];
}

const projectOfEntry = (e: { ref: { kind: string }; project?: string | null }) =>
  e.project ? e.project : e.ref.kind === 'task' ? OTHER : NONTASK;

/** 時間花在哪裡：依專案加總（多到少），`other`、`nontask` 放最後。 */
export function timeRows(worklog: DayLog[], days: string[]): TimeRow[] {
  const set = new Set(days);
  const sum = new Map<string, number>();
  for (const d of worklog) {
    if (!set.has(d.date)) continue;
    for (const e of d.entries) {
      const k = projectOfEntry(e);
      sum.set(k, (sum.get(k) ?? 0) + e.minutes);
    }
  }
  const rank = (p: string) => (p === OTHER ? 1 : p === NONTASK ? 2 : 0);
  return [...sum.entries()]
    .filter(([, m]) => m > 0)
    .map(([project, minutes]) => ({ project, minutes }))
    .sort((a, b) => rank(a.project) - rank(b.project) || b.minutes - a.minutes);
}

/** 每個任務的實際分鐘數（預估過低、計劃外用）。 */
function taskMinutes(worklog: DayLog[], days: string[]): Map<string, number> {
  const set = new Set(days);
  const out = new Map<string, number>();
  for (const d of worklog) {
    if (!set.has(d.date)) continue;
    for (const e of d.entries) {
      if (e.ref.kind !== 'task') continue;
      const k = `${e.ref.team}/${e.ref.task}`;
      out.set(k, (out.get(k) ?? 0) + e.minutes);
    }
  }
  return out;
}

/**
 * 我讓專案前進了多少：期末 = 小組目標目前進度；期初 = 上一期報告的期末（沒有時 null）；
 * 我推進 = 我對齊該小組目標的個人目標，期間內進度變化的平均（方向摘要，§16.14）。
 */
export function projectRows(
  projects: string[],
  goals: TeamGoal[],
  myWeeks: DirectionWeek[],
  weeks: string[],
  prev: ProjectRow[],
): ProjectRow[] {
  // 方向摘要由新到舊；取期間內最新一週與期間前（或期間第一週）的一週
  const inPeriod = myWeeks.filter((w) => weeks.includes(w.week));
  const latest = inPeriod[0] ?? null;
  const before =
    myWeeks.find((w) => w.week < (weeks[0] ?? '')) ?? inPeriod[inPeriod.length - 1] ?? null;
  return projects
    .filter((p) => p !== OTHER && p !== NONTASK)
    .map((p) => {
      const g = goals.find((x) => x.id === p);
      let mine = 0;
      if (latest && before && latest !== before) {
        const deltas = latest.goals
          .filter((x) => x.alignedGoalId === p)
          .map(
            (x) => x.progress - (before.goals.find((y) => y.id === x.id)?.progress ?? x.progress),
          );
        mine = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      }
      return {
        project: p,
        title: g?.title ?? '',
        start: prev.find((x) => x.project === p)?.end ?? null,
        end: Math.round((g?.progress ?? 0) * 10) / 10,
        mine: Math.round(mine * 10) / 10,
      };
    });
}

/** 實際 vs 原定計劃：計劃 = 週計劃快照各專案的預估分鐘；實際 = 時間。 */
export function planOf(
  snapshots: WeekPlan[],
  time: TimeRow[],
  tasks: Task[],
  carried: number,
): ReportData['plan'] {
  const planned = new Map<string, number>();
  let count = 0;
  let done = 0;
  for (const s of snapshots) {
    for (const x of s.tasks) {
      count++;
      if (x.ref.kind === 'task') {
        const ref = x.ref;
        if (tasks.some((t) => t.id === ref.task && t.status === 'done')) done++;
      }
      if (x.estimate && x.project)
        planned.set(x.project, (planned.get(x.project) ?? 0) + x.estimate);
    }
  }
  const projects = new Set([
    ...planned.keys(),
    ...time.filter((r) => r.project !== OTHER && r.project !== NONTASK).map((r) => r.project),
  ]);
  const minutes: PlanMinutes[] = [...projects].map((project) => ({
    project,
    planned: planned.get(project) ?? 0,
    actual: time.find((r) => r.project === project)?.minutes ?? 0,
  }));
  return { minutes, tasks: { planned: count, done, carried } };
}

/** 時間偏移 = Σ|實際 − 計劃| ÷ Σ計劃（%）；沒有計劃時 null。 */
export function deviationOf(plan: ReportData['plan']): number | null {
  const total = plan.minutes.reduce((n, r) => n + r.planned, 0);
  if (total <= 0) return null;
  const diff = plan.minutes
    .filter((r) => r.planned > 0)
    .reduce((n, r) => n + Math.abs(r.actual - r.planned), 0);
  return Math.round((diff / total) * 100);
}

export interface ReasonText {
  blocked: (title: string, text: string) => string;
  underestimate: (title: string, est: string, actual: string) => string;
  unplanned: (title: string) => string;
  reopened: (title: string, text: string) => string;
}

/** 偏離原因（自動找出，本人可增刪）：依影響時數排序。 */
export function reasonsOf(
  logs: MyLog[],
  snapshots: WeekPlan[],
  tasks: Task[],
  worklog: DayLog[],
  days: string[],
  tz: string,
  tx: ReasonText,
): Reason[] {
  const set = new Set(days);
  const inPeriod = (ms: number) => set.has(periodsAt(ms, tz).day);
  const minutes = taskMinutes(worklog, days);
  const out: Reason[] = [];
  for (const l of logs) {
    if (!inPeriod(l.log.at)) continue;
    if (l.log.kind === 'blocked')
      out.push({
        kind: 'blocked',
        text: tx.blocked(l.title, l.log.text),
        minutes: minutes.get(`${l.team}/${l.task}`) ?? null,
      });
    if (l.log.kind === 'reopen')
      out.push({ kind: 'reopened', text: tx.reopened(l.title, l.log.text), minutes: null });
  }
  const planned = new Set(
    snapshots.flatMap((s) =>
      s.tasks.flatMap((x) => (x.ref.kind === 'task' ? [`${x.ref.team}/${x.ref.task}`] : [])),
    ),
  );
  for (const [key, m] of minutes) {
    const task = tasks.find((t) => `${t.team}/${t.id}` === key);
    if (!task) continue;
    if (task.estimate && m >= task.estimate * 1.5) {
      out.push({
        kind: 'underestimate',
        text: tx.underestimate(task.title, hours(task.estimate), hours(m)),
        minutes: m - task.estimate,
      });
    } else if (snapshots.length > 0 && !planned.has(key) && m >= 30) {
      out.push({ kind: 'unplanned', text: tx.unplanned(task.title), minutes: m });
    }
  }
  return out.sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));
}

/** 分鐘 → 「2.5」小時（最多一位小數）。 */
export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

export interface SummaryText {
  empty: string;
  top: (title: string, h: string, share: number, mine: string) => string;
  rest: (other: string, unplanned: string, nontask: string) => string;
  tasks: (done: number, planned: number) => string;
  deviation: (pct: number) => string;
  because: (reasons: string) => string;
  /** 任務句的句尾 */
  end: string;
  reasonName: (kind: Reason['kind']) => string;
}

/** 摘要句型（D61）：投入最多的專案與時數、前進多少；其他專案、計劃外與非任務時間；完成件數、偏移與前兩個原因。 */
export function summaryOf(d: ReportData, titleOf: (p: string) => string, tx: SummaryText): string {
  const total = d.time.reduce((n, r) => n + r.minutes, 0);
  const projects = d.time.filter((r) => r.project !== OTHER && r.project !== NONTASK);
  const parts: string[] = [];
  if (total === 0) parts.push(tx.empty);
  else if (projects[0]) {
    const p = projects[0];
    const mine = d.projects.find((x) => x.project === p.project)?.mine ?? 0;
    parts.push(
      tx.top(
        titleOf(p.project),
        hours(p.minutes),
        Math.round((p.minutes / total) * 100),
        String(mine),
      ),
    );
  }
  if (total > 0) {
    const otherProjects = projects.slice(1).reduce((n, r) => n + r.minutes, 0);
    const unplanned = d.reasons
      .filter((r) => r.kind === 'unplanned')
      .reduce((n, r) => n + (r.minutes ?? 0), 0);
    const nontask = d.time.find((r) => r.project === NONTASK)?.minutes ?? 0;
    const other = d.time.find((r) => r.project === OTHER)?.minutes ?? 0;
    parts.push(tx.rest(hours(otherProjects + other), hours(unplanned), hours(nontask)));
  }
  if (d.plan.tasks.planned > 0) {
    let s = tx.tasks(d.plan.tasks.done, d.plan.tasks.planned);
    const dev = deviationOf(d.plan);
    if (dev !== null) s += tx.deviation(dev);
    const top = [...new Set(d.reasons.map((r) => r.kind))].slice(0, 2);
    if (top.length) s += tx.because(top.map(tx.reasonName).join('、'));
    parts.push(s + tx.end);
  }
  return parts.join('').trim();
}

export interface BuildInput {
  kind: PeriodKind;
  period: string;
  tz: string;
  worklog: DayLog[];
  snapshots: WeekPlan[];
  tasks: Task[];
  goals: TeamGoal[];
  myWeeks: DirectionWeek[];
  logs: MyLog[];
  prevProjects: ProjectRow[];
  carried: number;
  doneMd: string;
  nextMd: string;
  reasonText: ReasonText;
  summaryText: SummaryText;
}

/** 六段（本人範圍）。摘要以句型產生，呼叫端在使用者改過時保留原文。 */
export function buildReport(i: BuildInput): ReportData {
  const days = periodDays(i.kind, i.period);
  const weeks = weeksOf(days);
  const snapshots = i.snapshots.filter((s) => weeks.includes(s.week));
  const time = timeRows(i.worklog, days);
  const projects = projectRows(
    [
      ...new Set([
        ...time.map((r) => r.project),
        ...snapshots.flatMap((s) => s.tasks.map((x) => x.project ?? '')),
      ]),
    ].filter(Boolean),
    i.goals,
    i.myWeeks,
    weeks,
    i.prevProjects,
  );
  const plan = planOf(snapshots, time, i.tasks, i.carried);
  const reasons = reasonsOf(i.logs, snapshots, i.tasks, i.worklog, days, i.tz, i.reasonText);
  const d: ReportData = {
    summary: '',
    summaryEdited: false,
    time,
    projects,
    plan,
    reasons,
    doneMd: i.doneMd,
    nextMd: i.nextMd,
  };
  const titleOf = (p: string) => i.goals.find((g) => g.id === p)?.title ?? p;
  d.summary = summaryOf(d, titleOf, i.summaryText);
  return d;
}

/**
 * 多份報告合併（小組 / 全公司範圍、月 / 季 / 年用已發佈的週報）：只有專案層級。
 * 時間與計劃加總；專案取最新的期末、最早的期初、我推進加總；原因合併。
 */
export function mergeReports(list: ReportData[]): ReportData {
  const time = new Map<string, number>();
  const plan = new Map<string, PlanMinutes>();
  const projects = new Map<string, ProjectRow>();
  const tasks = { planned: 0, done: 0, carried: 0 };
  const reasons: Reason[] = [];
  for (const d of list) {
    for (const r of d.time) time.set(r.project, (time.get(r.project) ?? 0) + r.minutes);
    for (const r of d.plan.minutes) {
      const cur = plan.get(r.project) ?? { project: r.project, planned: 0, actual: 0 };
      cur.planned += r.planned;
      cur.actual += r.actual;
      plan.set(r.project, cur);
    }
    for (const p of d.projects) {
      const cur = projects.get(p.project);
      projects.set(
        p.project,
        cur
          ? {
              ...cur,
              end: Math.max(cur.end, p.end),
              start: cur.start ?? p.start,
              mine: cur.mine + p.mine,
            }
          : { ...p },
      );
    }
    tasks.planned += d.plan.tasks.planned;
    tasks.done += d.plan.tasks.done;
    tasks.carried += d.plan.tasks.carried;
    reasons.push(...d.reasons);
  }
  const rank = (p: string) => (p === OTHER ? 1 : p === NONTASK ? 2 : 0);
  return {
    summary: '',
    summaryEdited: false,
    time: [...time.entries()]
      .map(([project, minutes]) => ({ project, minutes }))
      .sort((a, b) => rank(a.project) - rank(b.project) || b.minutes - a.minutes),
    projects: [...projects.values()],
    plan: { minutes: [...plan.values()], tasks },
    reasons: reasons.sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0)).slice(0, 20),
    doneMd: list
      .map((d) => d.doneMd.trim())
      .filter(Boolean)
      .join('\n'),
    nextMd: list.length ? list[list.length - 1]!.nextMd : '',
  };
}

export type SectionKey = 'summary' | 'time' | 'projects' | 'plan' | 'reasons' | 'done';
export const SECTION_KEYS: SectionKey[] = [
  'summary',
  'time',
  'projects',
  'plan',
  'reasons',
  'done',
];

export interface MdText {
  section: (k: SectionKey) => string;
  next: string;
  project: (p: string) => string;
  reasonName: (k: Reason['kind']) => string;
  hoursUnit: string;
  deviation: (pct: number) => string;
  tasks: (done: number, planned: number, carried: number) => string;
  none: string;
}

/** Markdown（六段為 `##` 標題）。 */
export function reportMarkdown(
  title: string,
  meta: string,
  d: ReportData,
  sections: SectionKey[],
  tx: MdText,
  extra: string[] = [],
): string {
  const total = d.time.reduce((n, r) => n + r.minutes, 0);
  const out: string[] = [`# ${title}`, '', meta, ''];
  const add = (k: SectionKey, body: string[]) => {
    if (!sections.includes(k)) return;
    out.push(`## ${tx.section(k)}`, '', ...(body.length ? body : [`- ${tx.none}`]), '');
  };
  add('summary', [d.summary.trim()].filter(Boolean));
  add(
    'time',
    d.time.map(
      (r) =>
        `- ${tx.project(r.project)}：${hours(r.minutes)} ${tx.hoursUnit}（${total ? Math.round((r.minutes / total) * 100) : 0}%）`,
    ),
  );
  add(
    'projects',
    d.projects.map(
      (p) =>
        `- ${tx.project(p.project)}：${p.start === null ? '—' : `${Math.round(p.start)}%`} → ${Math.round(p.end)}%（+${p.mine}）`,
    ),
  );
  const dev = deviationOf(d.plan);
  add('plan', [
    ...d.plan.minutes.map(
      (r) =>
        `- ${tx.project(r.project)}：${hours(r.planned)} → ${hours(r.actual)} ${tx.hoursUnit}（${r.actual - r.planned >= 0 ? '+' : '−'}${hours(Math.abs(r.actual - r.planned))}）`,
    ),
    ...(dev !== null ? ['', tx.deviation(dev)] : []),
    tx.tasks(d.plan.tasks.done, d.plan.tasks.planned, d.plan.tasks.carried),
  ]);
  add(
    'reasons',
    d.reasons.map(
      (r) =>
        `- **${tx.reasonName(r.kind)}**：${r.text}${r.minutes ? `（${hours(r.minutes)} ${tx.hoursUnit}）` : ''}`,
    ),
  );
  if (sections.includes('done')) {
    out.push(`## ${tx.section('done')}`, '', d.doneMd.trim() || `- ${tx.none}`, '');
    out.push(`## ${tx.next}`, '', d.nextMd.trim() || `- ${tx.none}`, '');
  }
  out.push(...extra);
  return out.join('\n');
}

/** CSV（RFC 4180：含逗號、引號、換行的欄位加引號）。 */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** 本人範圍的 CSV 明細：日期、項目、專案、分鐘、來源。 */
export function worklogCsv(
  worklog: DayLog[],
  days: string[],
  header: string[],
  project: (p: string) => string,
  item: (title: string) => string,
): string {
  const set = new Set(days);
  const rows: (string | number)[][] = [header];
  for (const d of [...worklog].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!set.has(d.date)) continue;
    for (const e of d.entries) {
      const title = e.ref.kind === 'meeting' ? item('meeting') : e.ref.title;
      rows.push([d.date, title, project(projectOfEntry(e)), e.minutes, e.source]);
    }
  }
  return toCsv(rows);
}
