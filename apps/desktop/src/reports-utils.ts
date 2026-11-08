/** 日 / 週報的純函式（ui-spec「報表」、technical-design §16.13）。 */
import type { PlanView, ReportKind, ReportSections, Report, ScrumReport, Task } from './api';
import { periodsAt, periodsOfYmd } from './goals-utils';
import { addDays, isWorkday } from './scrum-utils';

/** 產生報表用的文字（由呼叫端以 i18n 提供，保持這裡為純函式）。 */
export interface ReportLabels {
  done: string;
  doing: string;
  blockers: string;
  none: string;
  weekDone: string;
  attendancePending: string;
  sections: Record<keyof ReportSections, string>;
}

const ymd = (date: string) => date.split('-').map(Number) as [number, number, number];

/** 某日所在的期間：日報 = 該日、週報 = ISO 週。 */
export function periodOf(kind: ReportKind, date: string): string {
  if (kind === 'daily') return date;
  const [y, m, d] = ymd(date);
  return periodsOfYmd(y, m, d).week;
}

/** ISO 週的週一。 */
export function mondayOf(week: string): string {
  const [ys, ws] = week.split('-W');
  const y = Number(ys);
  const w = Number(ws);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(Date.UTC(y, 0, 4 - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7));
  return mon.toISOString().slice(0, 10);
}

/** 期間內的日期（日報 1 天、週報週一到週日）。 */
export function daysOf(kind: ReportKind, period: string): string[] {
  if (kind === 'daily') return [period];
  const mon = mondayOf(period);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/** 上 / 下 n 期。 */
export function shiftPeriod(kind: ReportKind, period: string, n: number): string {
  if (kind === 'daily') return addDays(period, n);
  return periodOf('weekly', addDays(mondayOf(period), 7 * n));
}

/** 下一個工作日（日報的「下期」）。 */
export function nextWorkday(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 14 && !isWorkday(d); i++) d = addDays(d, 1);
  return d;
}

function bullets(items: string[], none: string): string {
  const uniq = [...new Set(items.map((s) => s.trim()).filter(Boolean))];
  return uniq.length ? uniq.map((s) => `- ${s}`).join('\n') : `- ${none}`;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export interface GenerateInput {
  kind: ReportKind;
  period: string;
  me: string;
  tz: string;
  scrum: ScrumReport[];
  tasks: Task[];
  plans: PlanView[];
  labels: ReportLabels;
}

/** 依 §16.13 的規則產生四個欄位（Markdown）。 */
export function generate(i: GenerateInput): ReportSections {
  const { kind, period, me, tz, labels: L } = i;
  const days = daysOf(kind, period);
  const inRange = (ms: number | null) => ms !== null && days.includes(periodsAt(ms, tz).day);
  const myScrum = i.scrum.filter((r) => r.member === me && days.includes(r.date));

  // 完成 / 進行中 / 阻礙
  const done: string[] = myScrum.flatMap((r) => r.done.map((x) => x.title));
  for (const t of i.tasks) {
    const steps = t.steps.filter((s) => s.done && s.assignee === me && inRange(s.doneAt));
    if (steps.length) done.push(`${t.title}：${steps.map((s) => s.title).join('、')}`);
    else if (t.status === 'done' && t.assignee === me && inRange(t.updatedAt)) done.push(t.title);
  }
  const doing = i.tasks
    .filter((t) => t.assignee === me && (t.status === 'doing' || t.status === 'review'))
    .map((t) => t.title);
  const blockers = myScrum.flatMap((r) => r.blockers.map((b) => b.text));
  const progress = [
    `**${L.done}**`,
    bullets(done, L.none),
    '',
    `**${L.doing}**`,
    bullets(doing, L.none),
    '',
    `**${L.blockers}**`,
    bullets(blockers, L.none),
  ].join('\n');

  // OKR 進度：包含期間的年 / 季目標
  const [y, m, d] = ymd(days[0]!);
  const p = periodsOfYmd(y, m, d);
  const okrLines: string[] = [];
  for (const g of i.plans.filter(
    (x) =>
      x.mine &&
      ((x.level === 'year' && x.period === p.year) ||
        (x.level === 'quarter' && x.period === p.quarter)),
  )) {
    okrLines.push(`- ${g.title} — ${Math.round(g.progress)}%`);
    for (const k of g.keyResults) {
      const v = Math.round(g.krProgress[k.id] ?? 0);
      okrLines.push(
        `  - ${k.title}：${fmtNum(k.current)} / ${fmtNum(k.target)}${k.unit ? ` ${k.unit}` : ''}（${v}%）`,
      );
    }
  }
  if (kind === 'weekly') {
    const weekDone = i.plans
      .filter((x) => x.mine && x.done && x.level === 'week' && x.period === period)
      .map((x) => x.title);
    if (weekDone.length) okrLines.push('', `**${L.weekDone}**`, bullets(weekDone, L.none));
  }
  const okr = okrLines.length ? okrLines.join('\n') : `- ${L.none}`;

  // 下期計劃
  const next: string[] = [];
  if (kind === 'daily') {
    // 下一個工作日到期的我的任務（D46 取消日目標，technical-design §16.13）
    const nd = nextWorkday(period);
    next.push(
      ...i.tasks
        .filter(
          (t) =>
            t.status !== 'done' &&
            t.dueAt !== null &&
            periodsAt(t.dueAt, tz).day === nd &&
            (t.assignee === me || t.steps.some((s) => s.assignee === me && !s.done)),
        )
        .map((t) => t.title),
    );
    const doneSet = new Set(done.map((s) => s.trim()));
    next.push(
      ...myScrum.flatMap((r) => r.today.map((x) => x.title)).filter((s) => !doneSet.has(s)),
    );
  } else {
    const nw = shiftPeriod('weekly', period, 1);
    const nextDays = daysOf('weekly', nw);
    next.push(
      ...i.plans
        .filter((x) => x.mine && x.level === 'week' && x.period === nw && !x.done)
        .map((x) => x.title),
    );
    next.push(
      ...i.tasks
        .filter(
          (t) =>
            t.status !== 'done' &&
            t.dueAt !== null &&
            nextDays.includes(periodsAt(t.dueAt, tz).day) &&
            (t.assignee === me || t.steps.some((s) => s.assignee === me && !s.done)),
        )
        .map((t) => t.title),
    );
  }
  return {
    progress,
    okr,
    attendance: L.attendancePending,
    next: bullets(next, L.none),
  };
}

const ORDER: (keyof ReportSections)[] = ['progress', 'okr', 'attendance', 'next'];

/** 匯出 Markdown：標題 + 四欄。 */
export function toMarkdown(title: string, s: ReportSections, labels: ReportLabels): string {
  return [
    `# ${title}`,
    '',
    ...ORDER.flatMap((k) => [
      `## ${labels.sections[k]}`,
      '',
      s[k].trim() || `- ${labels.none}`,
      '',
    ]),
  ].join('\n');
}

/** 小組彙整：依欄位把成員的報表合併（每人一個小標題）。 */
export function mergeTeam(
  reports: Report[],
  nameOf: (id: string) => string,
  labels: ReportLabels,
): ReportSections {
  const out = {} as ReportSections;
  for (const k of ORDER) {
    out[k] = reports.length
      ? reports.map((r) => `**${nameOf(r.member)}**\n\n${r.sections[k].trim()}`).join('\n\n')
      : `- ${labels.none}`;
  }
  return out;
}
