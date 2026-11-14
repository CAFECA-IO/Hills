/**
 * 本人報告的資料載入（technical-design §16.13 v0.34）：worklog、週計劃快照、方向摘要、任務紀錄、
 * 上一期週報，組成六段。只在本機計算。
 */
import { useState } from 'react';
import { api, type PlanView, type Reason, type ReportData, type Task } from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { dayStartIn } from './work-utils';
import {
  buildReport,
  monthsOf,
  periodDays,
  shiftKindPeriod,
  type PeriodKind,
} from './report-utils';
import { reasonText, summaryText } from './report-view';
import { addDays } from './scrum-utils';

const bullets = (items: string[]) =>
  [...new Set(items.map((s) => s.trim()).filter(Boolean))].map((s) => `- ${s}`).join('\n');

/** 做了什麼：期間內我完成的任務與步驟。 */
export function doneOf(tasks: Task[], me: string, days: string[], tz: string): string[] {
  const set = new Set(days);
  const inRange = (ms: number | null) => ms !== null && set.has(periodsAt(ms, tz).day);
  const out: string[] = [];
  for (const x of tasks) {
    if (x.status === 'done' && x.assignee === me && inRange(x.doneAt ?? x.updatedAt)) {
      out.push(x.title);
      continue;
    }
    const steps = x.steps.filter((s) => s.done && s.assignee === me && inRange(s.doneAt));
    if (steps.length) out.push(`${x.title}：${steps.map((s) => s.title).join('、')}`);
  }
  return out;
}

/** 下期：之後 7 天到期的我的未完成任務，加上下週的週目標。 */
export function nextOf(
  tasks: Task[],
  plans: PlanView[],
  me: string,
  days: string[],
  tz: string,
): string[] {
  const end = days[days.length - 1]!;
  const next = new Set(Array.from({ length: 7 }, (_, i) => addDays(end, i + 1)));
  const nextWeek = periodsAt(dayStartIn(addDays(end, 1), tz) + 3_600_000, tz).week;
  return [
    ...plans
      .filter((p) => p.mine && p.level === 'week' && p.period === nextWeek && !p.done)
      .map((p) => p.title),
    ...tasks
      .filter(
        (x) =>
          x.status !== 'done' &&
          x.dueAt !== null &&
          next.has(periodsAt(x.dueAt, tz).day) &&
          (x.assignee === me || x.steps.some((s) => s.assignee === me && !s.done)),
      )
      .map((x) => x.title),
  ];
}

/**
 * 本人某期的六段。`ready` 為 false 時資料還在載入。
 * 週報的期初取上一週已發佈週報的期末（§16.13）。
 */
export function useMyReport(
  kind: PeriodKind,
  period: string,
  me: string,
  tasks: Task[],
  timezone: string,
  carried = 0,
): { ready: boolean; build: () => ReportData; error: string | null } {
  const days = periodDays(kind, period);
  const months = monthsOf(days);
  const [since] = useState(() => dayStartIn(days[0]!, timezone));
  const worklog = useLoad(() => (me ? api.worklogDays(me, months) : Promise.resolve([])), ['doc']);
  const snapshots = useLoad(() => (me ? api.weekPlans(me, months) : Promise.resolve([])), ['doc']);
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const plans = useLoad(() => api.plans(true), ['doc']);
  const summaries = useLoad(api.directionSummaries, ['doc', 'org', 'roster']);
  const logs = useLoad(() => api.myLogsSince(since), ['doc']);
  const prevWeek = kind === 'weekly' ? shiftKindPeriod('weekly', period, -1) : null;
  const prev = useLoad(
    () =>
      prevWeek
        ? api.reportMine('weekly', prevWeek)
        : Promise.resolve({ report: null, draft: null }),
    ['doc', 'org'],
  );
  const ready = Boolean(
    worklog.data &&
    snapshots.data &&
    dirs.data &&
    plans.data &&
    summaries.data &&
    logs.data &&
    prev.data,
  );
  // 期末回顧的說明帶進差異原因（D67，technical-design §16.10 v0.36）
  const reviewReasons = (): Reason[] =>
    (plans.data ?? [])
      .filter(
        (p) =>
          p.mine &&
          p.review?.note &&
          p.review.at > 0 &&
          days.includes(periodsAt(p.review.at, timezone).day),
      )
      .map((p) => ({
        kind: 'other' as const,
        text: `${p.title}：${p.review!.note}`,
        minutes: null,
      }));
  const build = (): ReportData => {
    const d = buildReport({
      kind,
      period,
      tz: timezone,
      worklog: worklog.data ?? [],
      snapshots: snapshots.data ?? [],
      tasks,
      goals: dirs.data?.teamGoals ?? [],
      myWeeks: summaries.data?.find((s) => s.member === me)?.weeks ?? [],
      logs: (logs.data ?? []).filter((l) => days.includes(periodsAt(l.log.at, timezone).day)),
      prevProjects: prev.data?.report?.data?.projects ?? [],
      carried,
      doneMd: bullets(doneOf(tasks, me, days, timezone)),
      nextMd: bullets(nextOf(tasks, plans.data ?? [], me, days, timezone)),
      reasonText: reasonText(),
      summaryText: summaryText(),
    });
    return { ...d, reasons: [...d.reasons, ...reviewReasons()].slice(0, 50) };
  };
  return {
    ready,
    build,
    error:
      worklog.error ??
      snapshots.error ??
      dirs.error ??
      plans.error ??
      summaries.error ??
      logs.error ??
      null,
  };
}
