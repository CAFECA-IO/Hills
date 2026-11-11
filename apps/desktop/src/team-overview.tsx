/**
 * 小組 › 總覽（ui-spec「工作 › 小組」A5，D59）：每人一列——今天、卡住了、這週、方向、週報；
 * 需要注意的人排最上面；右欄「需要你處理」。
 */
import { useState } from 'react';
import { api, type MemberView, type Task, type TeamView } from './api';
import { periodsAt, type Periods } from './goals-utils';
import { HillPill, reasonOf } from './hill';
import { rankOf, type Walker } from './hill-utils';
import { useLoad } from './hooks';
import { formatClock, formatDate, t } from './i18n';
import { navigate } from './nav';
import { daysOf } from './reports-utils';
import { blockedDays } from './task-utils';
import { Avatar } from './figures';
import { Badge, Button, Card, EmptyState, LinkButton, ProgressBar } from './ui';
import { workMinutesOf } from './work-utils';

export interface Row {
  member: MemberView;
  walker: Walker | null;
  submittedAt: number | null;
  doing: Task | null;
  blocked: { count: number; days: number };
  week: { done: number; open: number; estimate: number; capacity: number };
  report: boolean;
  attention: number;
}

/** 列資料（純函式，方便測試）。需要注意的分數越高越前面。 */
export function rowsOf(
  team: TeamView,
  members: MemberView[],
  tasks: Task[],
  walkers: Walker[],
  submitted: Map<string, number>,
  reported: Set<string>,
  capacity: (member: string) => number,
  weekDays: Set<string>,
  dayOf: (ms: number) => string,
  now: number,
): Row[] {
  const ids = new Set([...team.members, ...team.leads]);
  return members
    .filter((m) => ids.has(m.id))
    .map((m) => {
      const mine = tasks.filter((x) => x.team === team.id && x.assignee === m.id);
      const blockedList = mine.filter((x) => x.status !== 'done' && x.blocked);
      const thisWeek = mine.filter(
        (x) =>
          (x.dueAt !== null && weekDays.has(dayOf(x.dueAt))) ||
          (x.status === 'done' && x.doneAt !== null && weekDays.has(dayOf(x.doneAt))),
      );
      const walker = walkers.find((w) => w.member.id === m.id) ?? null;
      const days = blockedList.reduce(
        (n, x) => Math.max(n, x.blocked ? blockedDays(x.blocked.since, now) : 0),
        0,
      );
      const open = thisWeek.filter((x) => x.status !== 'done');
      const row: Row = {
        member: m,
        walker,
        submittedAt: submitted.get(m.id) ?? null,
        doing: mine.find((x) => x.status === 'doing') ?? null,
        blocked: { count: blockedList.length, days },
        week: {
          done: thisWeek.length - open.length,
          open: open.length,
          estimate: open.reduce((n, x) => n + (x.estimate ?? 0), 0),
          capacity: capacity(m.id),
        },
        report: reported.has(m.id),
        attention: 0,
      };
      const leave = m.presence === 'Leave';
      row.attention = leave
        ? -1
        : (walker ? 6 - Math.min(6, rankOf(walker.kind)) : 0) +
          blockedList.length * 3 +
          (row.submittedAt === null ? 1 : 0);
      return row;
    })
    .sort((a, b) => b.attention - a.attention || a.member.name.localeCompare(b.member.name));
}

export function TeamOverview({
  team,
  members,
  tasks,
  walkers,
  periods,
  timezone,
  isLead,
  onBoard,
  onMessage,
}: {
  team: TeamView;
  members: MemberView[];
  tasks: Task[];
  walkers: Walker[];
  periods: Periods;
  timezone: string;
  isLead: boolean;
  onBoard: () => void;
  onMessage: (member: string) => void;
}) {
  const today = periods.day;
  const scrum = useLoad(() => api.scrumTeam(team.id, today, today), ['doc', 'org']);
  const reports = useLoad(() => api.reportTeam(team.id, 'weekly', periods.week), ['doc', 'org']);
  const profiles = useLoad(api.memberProfiles, ['doc', 'roster']);
  const [now] = useState(() => Date.now());
  const week = daysOf('weekly', periods.week);
  const weekDays = new Set(week);
  const dayOf = (ms: number) => periodsAt(ms, timezone).day;
  const submitted = new Map((scrum.data ?? []).map((r) => [r.member, r.submittedAt]));
  const reported = new Set((reports.data ?? []).map((r) => r.member));
  const capacity = (id: string) => {
    const hours = profiles.data?.find((p) => p.member === id)?.workHours;
    return week.slice(0, 7).reduce((n, d) => n + workMinutesOf(d, hours), 0);
  };
  const rows = rowsOf(
    team,
    members,
    tasks,
    walkers,
    submitted,
    reported,
    capacity,
    weekDays,
    dayOf,
    now,
  );
  const active = rows.filter((r) => r.member.presence !== 'Leave');
  const notSent = active.filter((r) => r.submittedAt === null);
  const blocked = tasks.filter((x) => x.team === team.id && x.status !== 'done' && x.blocked);
  const pending = tasks.filter((x) => x.team === team.id && x.pendingAck);
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '?';
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] gap-3 wide:grid-cols-[minmax(0,1fr)_360px] wide:gap-4">
      <Card className="scroll-panel flex min-h-0 flex-col p-0">
        <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
          <h2 className="font-bold">{t('tov.title')}</h2>
          <span className="text-xs text-muted">
            {t('tov.summary', {
              sent: active.length - notSent.length,
              n: active.length,
              blocked: rows.filter((r) => r.blocked.count > 0).length,
            })}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState art="team">{t('tov.empty')}</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line bg-bg text-left text-xs text-muted">
                <th className="px-4 py-2 font-semibold">{t('tov.col.member')}</th>
                <th className="px-2 py-2 font-semibold">{t('tov.col.today')}</th>
                <th className="px-2 py-2 font-semibold">{t('tov.col.blocked')}</th>
                <th className="px-2 py-2 font-semibold">{t('tov.col.week')}</th>
                <th className="px-2 py-2 font-semibold">{t('tov.col.direction')}</th>
                <th className="px-2 py-2 font-semibold">{t('tov.col.report')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const leave = r.member.presence === 'Leave';
                const load = r.week.capacity > 0 ? r.week.estimate / r.week.capacity : 0;
                return (
                  <tr key={r.member.id} className="border-b border-line align-top">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <Avatar member={r.member} size={28} />
                        <span className="font-semibold">
                          {r.member.isMe ? t('hill.you') : r.member.name}
                        </span>
                      </span>
                    </td>
                    {leave ? (
                      <td colSpan={5} className="px-2 py-2.5 text-xs text-muted">
                        {r.member.until
                          ? t('tov.leaveUntil', { date: formatDate(r.member.until) })
                          : t('tov.leave')}
                      </td>
                    ) : (
                      <>
                        <td className="px-2 py-2.5 text-xs">
                          {r.submittedAt !== null ? (
                            <span className="text-st-online-text">
                              {t('tov.sent', { time: formatClock(r.submittedAt) })}
                            </span>
                          ) : (
                            <span className="text-warning">{t('tov.notSent')}</span>
                          )}
                          {r.doing && (
                            <span className="block truncate text-muted">
                              {t('tov.doing', { title: r.doing.title })}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {r.blocked.count > 0 ? (
                            <Badge tone="alert">
                              {t('tov.blockedN', { n: r.blocked.count, days: r.blocked.days })}
                            </Badge>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          <span className="block">
                            {t('tov.weekTasks', { done: r.week.done, open: r.week.open })}
                          </span>
                          {r.week.capacity > 0 && r.week.estimate > 0 && (
                            <ProgressBar
                              size="sm"
                              value={Math.min(1, load)}
                              barClassName={load > 1 ? 'bg-warning' : 'bg-primary'}
                              label={t('tov.load', { p: Math.round(load * 100) })}
                            />
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {r.walker && (
                            <span className="flex flex-col gap-0.5">
                              <HillPill kind={r.walker.kind} />
                              <span className="text-xs text-muted">{reasonOf(r.walker)}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-xs">
                          {r.report ? (
                            <span className="text-st-online-text">{t('tov.published')}</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <aside className="scroll-panel flex min-h-0 flex-col gap-3">
        <Card className="flex flex-col gap-2">
          <h2 className="text-sm font-bold">{isLead ? t('tov.needs') : t('tov.needsTeam')}</h2>
          {blocked.length === 0 && pending.length === 0 && notSent.length === 0 && (
            <p className="text-xs text-muted">{t('tov.needs.none')}</p>
          )}
          {blocked.map((x) => (
            <div key={x.id} className="flex flex-col gap-1 border-b border-line pb-2 last:border-0">
              <span className="text-sm">
                <Badge tone="alert">{t('tov.blocked')}</Badge>{' '}
                <span className="font-semibold">{x.title}</span>
              </span>
              <span className="text-xs text-muted">
                {nameOf(x.assignee)}：{x.blocked?.text}
              </span>
              <LinkButton
                className="self-start text-xs"
                onClick={() => navigate({ page: 'task', team: x.team, task: x.id })}
              >
                {t('tov.reply')}
              </LinkButton>
            </div>
          ))}
          {pending.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1">{t('tov.pending', { n: pending.length })}</span>
              <LinkButton className="text-xs" onClick={onBoard}>
                {t('tov.toBoard')}
              </LinkButton>
            </div>
          )}
          {isLead &&
            notSent.map((r) => (
              <div key={r.member.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{t('tov.notSentName', { name: r.member.name })}</span>
                {!r.member.isMe && (
                  <Button size="sm" variant="secondary" onClick={() => onMessage(r.member.id)}>
                    {t('hill.message')}
                  </Button>
                )}
              </div>
            ))}
        </Card>
        <p className="mt-auto text-xs text-muted">{t('tov.privacy')}</p>
      </aside>
    </div>
  );
}
