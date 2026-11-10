/**
 * 工作 › 這週（ui-spec「工作 › 這週」v0.42，D59、D62）：週一「排這一週」提示列、
 * 週目標 × 星期的任務板（拖曳改期限或週目標）、往上推的進度與週五收尾入口。
 */
import { useMemo, useState, type DragEvent } from 'react';
import { api, type MemberView, type PlanView, type Task, type TeamView } from './api';
import { DEFAULT_RULES } from './drift-utils';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { t } from './i18n';
import { daysOf, shiftPeriod } from './reports-utils';
import { TaskDialog } from './tasks';
import { WeeklyCheck } from './weekly-check';
import { dayStartIn, hm, weekPlanFrom, workMinutesOf } from './work-utils';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  IconButton,
  LinkButton,
  Pressable,
  ProgressBar,
  SectionLabel,
  Toast,
  useAction,
} from './ui';
import type { ToastState } from './goals-guided';

interface Props {
  tasks: Task[];
  members: MemberView[];
  teams: TeamView[];
  timezone: string;
  onFriday: () => void;
}

/** 欄：週一…週五、六日、未排日期。 */
type Col = number | 'weekend' | 'none';
const COLS: Col[] = [0, 1, 2, 3, 4, 'weekend', 'none'];

export function Week({ tasks, members, teams, timezone, onFriday }: Props) {
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const [now] = useState(() => Date.now());
  const periods = periodsAt(now, timezone);
  const [shift, setShift] = useState(0);
  // 週五 16:00 起「週五收尾」為主要樣式（ui-spec「工作 › 這週」）
  const fridayNow =
    shift === 0 && now >= dayStartIn(daysOf('weekly', periods.week)[4]!, timezone) + 16 * 3_600_000;
  const week = shiftPeriod('weekly', periods.week, shift);
  const days = daysOf('weekly', week);
  const plans = useLoad(() => api.plans(true), ['doc', 'org', 'roster']);
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const summaries = useLoad(api.directionSummaries, ['doc', 'org', 'roster']);
  const rules = useLoad(api.directionRules, ['org']);
  const weekNotes = useLoad(api.weekNotes, ['doc', 'org', 'roster']);
  const profile = useLoad(api.myProfile, ['doc']);
  const months = [...new Set([days[0]!.slice(0, 7), days[6]!.slice(0, 7)])];
  const weekPlans = useLoad(
    () => (meId ? api.weekPlans(meId, months) : Promise.resolve([])),
    ['doc'],
  );
  const [view, setView] = useState<'board' | 'plan'>('board');
  const [later, setLater] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [toast, setToast] = useState<(ToastState & { key: number }) | null>(null);
  const { error, attempt } = useAction();
  const items = useMemo(() => plans.data ?? [], [plans.data]);
  const goals = items.filter((p) => p.mine && p.level === 'week' && p.period === week);
  const goalIds = new Set(goals.map((g) => g.id));
  const teamGoalIds = new Set((dirs.data?.teamGoals ?? []).map((g) => g.id));
  const planned = (weekPlans.data ?? []).some((p) => p.week === week);
  const isThisWeek = week === periods.week;
  const mine = tasks.filter(
    (x) =>
      x.assignee === meId ||
      x.team === 'private' ||
      x.steps.some((s) => s.assignee === meId && !s.done),
  );
  const colOf = (x: Task): Col => {
    if (x.dueAt === null) return 'none';
    const d = periodsAt(x.dueAt, timezone).day;
    const i = days.indexOf(d);
    if (i < 0) return 'none';
    return i >= 5 ? 'weekend' : i;
  };
  const inWeek = (x: Task) => {
    if (goalIds.has(x.planItemId ?? '')) return true;
    if (x.dueAt === null) return x.status !== 'done';
    const d = periodsAt(x.dueAt, timezone).day;
    return days.includes(d) || (x.status !== 'done' && d < days[0]!);
  };
  const lanes: { id: string | null; title: string; goal: PlanView | null }[] = [
    ...goals.map((g) => ({ id: g.id, title: g.title, goal: g })),
    { id: null, title: t('week.unlinked'), goal: null },
  ];
  const laneTasks = (id: string | null) =>
    mine.filter(
      (x) => inWeek(x) && (id === null ? !goalIds.has(x.planItemId ?? '') : x.planItemId === id),
    );
  const move = (x: Task, col: Col, lane: string | null) =>
    void attempt(async () => {
      const time =
        x.dueAt === null
          ? 18 * 3_600_000
          : x.dueAt - dayStartIn(periodsAt(x.dueAt, timezone).day, timezone);
      const dueAt =
        col === 'none'
          ? null
          : dayStartIn(col === 'weekend' ? days[5]! : days[col]!, timezone) + time;
      await api.updateTask(x.team, x.id, {
        title: x.title,
        assignee: x.assignee,
        status: x.status,
        dueAt,
        estimate: x.estimate ?? null,
        steps: x.steps.map((s) => ({
          id: s.id,
          title: s.title,
          assignee: s.assignee,
          done: s.done,
          estimate: s.estimate ?? null,
        })),
        planItemId: lane,
        teamGoalId: x.teamGoalId,
      });
    });
  const capacity = workMinutesOf(days[0]!, profile.data?.workHours) * 5;

  if (view === 'plan' && me) {
    return (
      <WeeklyCheck
        me={me}
        members={members}
        teams={teams}
        weeks={summaries.data?.find((m) => m.member === meId)?.weeks ?? []}
        rules={rules.data ?? DEFAULT_RULES}
        plans={items}
        tasks={tasks}
        weekNotes={weekNotes.data ?? []}
        periods={periods}
        timezone={timezone}
        onLater={() => setView('board')}
        onDone={() => {
          // 存成本週計劃快照（D62）
          void api
            .tasks()
            .then((fresh) =>
              api.setWeekPlan(
                periods.week,
                weekPlanFrom(fresh, meId, periods.week, timezone, items, teamGoalIds, capacity),
              ),
            )
            .then(() => weekPlans.reload())
            .catch(() => undefined);
          setView('board');
        }}
        notify={(s) => setToast({ ...s, key: Date.now() })}
      />
    );
  }
  const note = weekNotes.data?.find((n) => n.week === periods.week)?.text ?? null;
  const unlinked = laneTasks(null).filter((x) => x.status !== 'done').length;
  const estimate = mine
    .filter((x) => inWeek(x) && x.status !== 'done')
    .reduce((n, x) => n + (x.estimate ?? 0), 0);
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] grid-rows-[auto_minmax(0,1fr)] gap-3 wide:gap-4">
      <div className="col-span-2 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <IconButton
            variant="secondary"
            label={t('report.prev')}
            onClick={() => setShift((s) => s - 1)}
          >
            ◀
          </IconButton>
          <strong className="px-1 text-sm">
            {days[0]!.slice(5).replace('-', '/')} – {days[6]!.slice(5).replace('-', '/')} ·{' '}
            {week.slice(5)}
          </strong>
          <IconButton
            variant="secondary"
            label={t('report.next')}
            onClick={() => setShift((s) => s + 1)}
          >
            ▶
          </IconButton>
        </div>
        {isThisWeek && !planned && !later && (
          <div className="flex min-w-0 flex-1 items-center gap-3 rounded-control bg-level-year/15 px-4 py-2">
            <Badge tone="primary">{t('week.monday')}</Badge>
            <span className="min-w-0 flex-1 text-sm">
              <strong>{t('week.banner', { n: unlinked })}</strong>
              {note && <span className="text-muted"> · {t('week.note', { text: note })}</span>}
            </span>
            <LinkButton tone="muted" className="text-sm" onClick={() => setLater(true)}>
              {t('weekly.later')}
            </LinkButton>
            <Button size="sm" onClick={() => setView('plan')}>
              {t('week.plan')}
            </Button>
          </div>
        )}
      </div>
      <Card className="scroll-panel flex min-h-0 flex-col gap-2">
        <div className="grid grid-cols-[150px_repeat(7,minmax(0,1fr))] gap-1.5 text-xs font-semibold text-muted">
          <span>{t('week.goal')}</span>
          {COLS.map((c) => (
            <span
              key={String(c)}
              className={`text-center ${typeof c === 'number' && days[c] === periods.day ? 'font-bold text-primary' : ''}`}
            >
              {typeof c === 'number'
                ? `${t(`scrum.weekday.${(c + 1) % 7}` as 'scrum.weekday.1')} ${days[c]!.slice(5).replace('-', '/')}`
                : t(c === 'weekend' ? 'week.weekend' : 'week.none')}
            </span>
          ))}
        </div>
        {lanes.map((l) => (
          <Lane
            key={l.id ?? 'none'}
            lane={l}
            tasks={laneTasks(l.id)}
            colOf={colOf}
            today={periods.day}
            days={days}
            onMove={move}
            onOpen={setEditing}
          />
        ))}
        <ErrorText message={error} />
        <p className="mt-auto text-xs text-muted">{t('week.dragHint')}</p>
      </Card>
      <div className="flex min-h-0 flex-col gap-3">
        <Card className="flex flex-col gap-2">
          <SectionLabel>{t('week.chain')}</SectionLabel>
          <ChainProgress plans={items} periods={periods} />
        </Card>
        <Card className="flex flex-col gap-1 text-sm">
          <SectionLabel>{t('week.time')}</SectionLabel>
          <span>{t('week.estimate', { e: hm(estimate), c: hm(capacity) })}</span>
          {planned && <span className="text-xs text-muted">{t('week.planned')}</span>}
        </Card>
        <Card className={`flex flex-col gap-2 ${fridayNow ? 'bg-primary-soft' : ''}`}>
          <SectionLabel>{t('week.friday')}</SectionLabel>
          <p className="text-xs text-muted">{t('week.friday.desc')}</p>
          <Button
            size="sm"
            variant={fridayNow ? 'primary' : 'secondary'}
            className="self-start"
            onClick={onFriday}
          >
            {t('week.friday.open')}
          </Button>
        </Card>
      </div>
      {editing && (
        <TaskDialog
          task={editing}
          teams={teams.filter((x) => x.members.includes(meId) || x.leads.includes(meId))}
          members={members}
          timezone={timezone}
          onClose={() => setEditing(null)}
        />
      )}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          action={toast.undo ? { label: t('guide.undo'), onClick: toast.undo } : undefined}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

function Lane({
  lane,
  tasks,
  colOf,
  today,
  days,
  onMove,
  onOpen,
}: {
  lane: { id: string | null; title: string; goal: PlanView | null };
  tasks: Task[];
  colOf: (x: Task) => Col;
  today: string;
  days: string[];
  onMove: (x: Task, col: Col, lane: string | null) => void;
  onOpen: (x: Task) => void;
}) {
  const [over, setOver] = useState<Col | null>(null);
  const done = tasks.filter((x) => x.status === 'done').length;
  const drop = (col: Col) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(null);
    const key = e.dataTransfer.getData('text/plain');
    const x = tasks.find((y) => `${y.team}/${y.id}` === key) ?? DRAG.current;
    if (x) onMove(x, col, lane.id);
  };
  return (
    <div className="grid min-h-24 grid-cols-[150px_repeat(7,minmax(0,1fr))] gap-1.5">
      <div className="flex flex-col gap-1 py-1 pr-2">
        <strong className={`text-sm ${lane.goal ? '' : 'text-warning'}`}>{lane.title}</strong>
        {lane.goal ? (
          <>
            <ProgressBar
              size="sm"
              barClassName="bg-st-online"
              value={lane.goal.progress / 100}
              label={t('week.lane.progress', { done, total: tasks.length })}
            />
            <span className="text-xs text-muted">
              {t('week.lane.progress', { done, total: tasks.length })}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted">{t('week.unlinked.hint')}</span>
        )}
      </div>
      {COLS.map((c) => {
        const isToday = typeof c === 'number' && days[c] === today;
        return (
          <div
            key={String(c)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(c);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={drop(c)}
            className={`flex flex-col gap-1 rounded-control p-1 ${over === c ? 'bg-primary-soft' : isToday ? 'bg-primary-soft/40' : lane.goal ? 'bg-bg' : 'bg-warning/5'}`}
          >
            {tasks
              .filter((x) => colOf(x) === c)
              .map((x) => (
                <div
                  key={`${x.team}/${x.id}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', `${x.team}/${x.id}`);
                    DRAG.current = x;
                  }}
                >
                  <Pressable
                    onClick={() => onOpen(x)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-control border bg-surface px-2 py-1.5 text-left text-xs ${x.blocked ? 'border-warning' : 'border-line'} ${x.status === 'done' ? 'text-muted line-through' : ''}`}
                  >
                    <strong className="line-clamp-2 font-semibold">{x.title}</strong>
                    <span className="text-muted">
                      {x.blocked
                        ? t('tlog.kind.blocked')
                        : x.steps.length > 0
                          ? `${x.steps.filter((s) => s.done).length}/${x.steps.length}`
                          : x.reported
                            ? `${x.reported}%`
                            : ''}
                    </span>
                  </Pressable>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** 拖曳中的任務（dataTransfer 在某些 WebView 取不到時的後備）。 */
const DRAG: { current: Task | null } = { current: null };

function ChainProgress({
  plans,
  periods,
}: {
  plans: PlanView[];
  periods: ReturnType<typeof periodsAt>;
}) {
  const avg = (level: PlanView['level'], period: string) => {
    const xs = plans.filter((p) => p.mine && p.level === level && p.period === period);
    return xs.length ? xs.reduce((n, p) => n + p.progress, 0) / xs.length : null;
  };
  const rows: [string, number | null][] = [
    [t('week.chain.week'), avg('week', periods.week)],
    [t('week.chain.month'), avg('month', periods.month)],
    [t('week.chain.quarter'), avg('quarter', periods.quarter)],
    [t('week.chain.year'), avg('year', periods.year)],
  ];
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_36px] items-center gap-x-2 gap-y-1.5 text-xs">
      {rows.map(([label, v]) => (
        <span key={label} className="contents">
          <span className="text-muted">{label}</span>
          <ProgressBar size="sm" value={(v ?? 0) / 100} label={`${label} ${Math.round(v ?? 0)}%`} />
          <span className="text-right">{v === null ? '—' : `${Math.round(v)}%`}</span>
        </span>
      ))}
    </div>
  );
}
