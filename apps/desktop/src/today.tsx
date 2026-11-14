/**
 * 工作 › 今天（ui-spec「工作 › 今天」v0.42，D59、D60、D62）：今天要做的任務（主動作、回報進度、
 * 卡住了、開始做計時）與每日任務卡、昨天的時間。
 */
import { ExportButton } from './report-export';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type MemberView,
  type Task,
  type TeamView,
  type TimerRunning,
  type WorkEntry,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { formatClock, t } from './i18n';
import { MyScrum } from './scrum';
import { prevWorkday } from './scrum-utils';
import { TaskCloseDialog } from './task-close';
import { TaskDetail } from './task-detail';
import { blockedDays, canBlock, canClose, closeIsPrimary, canReport } from './task-utils';
import {
  clock,
  dayStartIn,
  entriesFromSegments,
  hm,
  projectOf,
  refKey,
  round15,
  taskRef,
  todayList,
  workMinutesOf,
} from './work-utils';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  IconButton,
  LinkButton,
  Pressable,
  SectionLabel,
  TextInput,
  Toast,
  useAction,
} from './ui';

interface Props {
  tasks: Task[];
  members: MemberView[];
  teams: TeamView[];
  focusId: string | null;
  timezone: string;
  onAllTasks: () => void;
  onTeam: () => void;
}

/** 目前的計時（每秒更新顯示）。 */
export function useTimer() {
  const timer = useLoad(api.timerState, ['doc']);
  const [now, setNow] = useState(() => Date.now());
  const running = timer.data?.current ? timer.data : null;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return { timer: timer.data ?? null, reload: timer.reload, now };
}

export function Today({ tasks, members, teams, focusId, timezone, onAllTasks, onTeam }: Props) {
  const me = members.find((m) => m.isMe)?.id ?? '';
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const list = useMemo(
    () => todayList(tasks, me, focusId, today, timezone),
    [tasks, me, focusId, today, timezone],
  );
  const doneToday = tasks.filter(
    (x) => x.status === 'done' && x.doneAt !== null && periodsAt(x.doneAt, timezone).day === today,
  ).length;
  const { timer, reload, now: tick } = useTimer();
  const [closing, setClosing] = useState<Task | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_380px] gap-3 wide:grid-cols-[minmax(0,1fr)_420px] wide:gap-4">
      <Card className="scroll-panel flex min-h-0 flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-bold">{t('today.title')}</h2>
          <span className="text-xs text-muted">{t('today.count', { n: list.length })}</span>
        </div>
        {list.length === 0 && <p className="text-sm text-muted">{t('today.empty')}</p>}
        <ul className="flex flex-col gap-2">
          {list.map((x) => (
            <TodayRow
              key={`${x.team}/${x.id}`}
              task={x}
              me={me}
              members={members}
              teams={teams}
              focus={x.id === focusId}
              timer={timer}
              now={tick || now}
              today={today}
              timezone={timezone}
              onTimer={reload}
              onClose={() => setClosing(x)}
            />
          ))}
        </ul>
        <QuickAdd teams={teams} me={me} today={today} timezone={timezone} />
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-2 text-xs text-muted">
          <span>{t('today.doneToday', { n: doneToday })}</span>
          <span className="flex-1" />
          <LinkButton className="text-xs" onClick={onAllTasks}>
            {t('today.allTasks')}
          </LinkButton>
        </div>
      </Card>
      <div className="flex min-h-0 flex-col gap-3">
        <MyScrum
          date={today}
          editable
          members={members}
          tasks={tasks}
          focusId={focusId}
          timezone={timezone}
          me={me}
          headExtra={
            <ExportButton
              label={t('exp.go.daily')}
              initialKind="daily"
              members={members}
              teams={teams}
              tasks={tasks}
              timezone={timezone}
            />
          }
        />
        <YesterdayTime me={me} tasks={tasks} timezone={timezone} today={today} />
        <LinkButton className="self-start text-sm" onClick={onTeam}>
          {t('today.team')}
        </LinkButton>
      </div>
      {closing && (
        <TaskCloseDialog
          task={closing}
          onClose={() => setClosing(null)}
          onDone={() => setToast(t('close.done', { title: closing.title }))}
        />
      )}
      {toast && <Toast key={toast} message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function TodayRow({
  task,
  me,
  members,
  teams,
  focus,
  timer,
  now,
  today,
  timezone,
  onTimer,
  onClose,
}: {
  task: Task;
  me: string;
  members: MemberView[];
  teams: TeamView[];
  focus: boolean;
  timer: TimerRunning | null;
  now: number;
  today: string;
  timezone: string;
  onTimer: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const { busy, error, attempt } = useAction();
  const step = task.steps.find((s) => !s.done && (s.assignee === me || s.assignee === null));
  const running =
    timer?.current?.kind === 'task' &&
    timer.current.task === task.id &&
    timer.current.team === task.team;
  const due = task.dueAt === null ? null : periodsAt(task.dueAt, timezone).day;
  const overdue = due !== null && due < today;
  const overdueDays = overdue ? blockedDays(task.dueAt ?? now, now) : 0;
  const startTimer = () =>
    void attempt(async () => {
      await api.timerStart(taskRef(task, step), 'start');
      onTimer();
    });
  return (
    <li
      className={`flex flex-col gap-2 rounded-control border p-3 ${running ? 'border-primary bg-primary-soft/40' : overdue ? 'border-warning' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pressable
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 truncate rounded-sm text-left font-semibold"
        >
          {task.title}
        </Pressable>
        {overdue && <Badge tone="alert">{t('today.overdue', { n: overdueDays })}</Badge>}
        {focus && <Badge tone="primary">{t('tasks.focus')}</Badge>}
        {task.blocked && (
          <Badge tone="alert">
            {t('tasks.blocked', { days: blockedDays(task.blocked.since, now) })}
          </Badge>
        )}
        <span className="text-xs text-muted">
          {task.dueAt ? formatClock(task.dueAt) : t('tasks.noDue')}
          {task.steps.length > 0 &&
            ` · ${t('tasks.progress', { done: task.steps.filter((s) => s.done).length, total: task.steps.length })}`}
          {task.estimate ? ` · ${t('today.estimate', { h: hm(task.estimate) })}` : ''}
        </span>
        {running ? (
          <span className="flex items-center gap-1">
            <span className="font-mono text-sm font-bold tabular-nums">
              {clock(now - (timer?.since ?? now))}
            </span>
            <IconButton
              size="sm"
              label={t('today.pause')}
              onClick={() =>
                void attempt(async () => {
                  await api.timerStop(null, false);
                  onTimer();
                })
              }
            >
              ❚❚
            </IconButton>
          </span>
        ) : (
          <Button size="sm" variant="soft" disabled={busy} onClick={startTimer}>
            {t('today.start')}
          </Button>
        )}
        {canReport(task, me) && (
          <Button size="sm" variant="secondary" onClick={() => setReporting((r) => !r)}>
            {t('tdetail.progress')}
          </Button>
        )}
        {step && (step.assignee === me || task.assignee === me) ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void attempt(() => api.setStepDone(task.team, task.id, step.id, true))}
          >
            {t('today.doneStep', { step: step.title })}
          </Button>
        ) : canClose(task, me) ? (
          <Button
            size="sm"
            variant={closeIsPrimary(task, me) ? 'primary' : 'secondary'}
            onClick={onClose}
          >
            {t('tasks.close')}
          </Button>
        ) : null}
      </div>
      {task.blocked && (
        <p className="pl-1 text-xs text-muted">
          {t('today.blockedBy', { text: task.blocked.text })}
        </p>
      )}
      {reporting && <ReportLine task={task} me={me} onDone={() => setReporting(false)} />}
      <ErrorText message={error} />
      {open && <TaskDetail task={task} members={members} teams={teams} />}
    </li>
  );
}

function ReportLine({ task, me, onDone }: { task: Task; me: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [percent, setPercent] = useState('');
  const { busy, error, attempt } = useAction();
  const pct = percent.trim() === '' ? null : Math.max(0, Math.min(100, Number(percent)));
  const send = async (kind: 'progress' | 'blocked') => {
    if (
      await attempt(() =>
        api.addTaskLog(task.team, task.id, kind, text, kind === 'progress' ? pct : null),
      )
    )
      onDone();
  };
  return (
    <div className="flex flex-col gap-1 pl-1">
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          size="sm"
          autoFocus
          className="min-w-0 flex-1"
          aria-label={t('tdetail.composer')}
          placeholder={t('tdetail.composer.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <TextInput
          size="sm"
          type="number"
          min={0}
          max={100}
          className="w-20"
          aria-label={t('tdetail.percent.label')}
          placeholder="%"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
        <Button
          size="sm"
          variant="soft"
          disabled={busy || !text.trim()}
          onClick={() => void send('progress')}
        >
          {t('today.send')}
        </Button>
        {canBlock(task, me) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !text.trim()}
            onClick={() => void send('blocked')}
          >
            {t('tdetail.question')}
          </Button>
        )}
      </div>
      <ErrorText message={error} />
    </div>
  );
}

function QuickAdd({
  teams,
  me,
  today,
  timezone,
}: {
  teams: TeamView[];
  me: string;
  today: string;
  timezone: string;
}) {
  const [text, setText] = useState('');
  const { error, attempt } = useAction();
  const team = teams.find((x) => x.members.includes(me))?.id ?? 'private';
  const add = async () => {
    const title = text.trim();
    if (!title) return;
    // 期限：今天 18:00（組織時區）
    const dueAt = dayStartIn(today, timezone) + 18 * 3_600_000;
    if (
      await attempt(() =>
        api.createTask(team, {
          title,
          assignee: team === 'private' ? null : me,
          dueAt,
          steps: [],
        }),
      )
    )
      setText('');
  };
  return (
    <div className="flex flex-col gap-1">
      <TextInput
        className="border-dashed"
        value={text}
        maxLength={200}
        aria-label={t('today.add')}
        placeholder={t('today.add')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void add();
          }
        }}
      />
      <ErrorText message={error} />
    </div>
  );
}

/**
 * 昨天的時間（D62）：第一次打開時把前一個工作日的計時片段整理成逐筆時間寫入工作紀錄；
 * 可以 ± 15 分鐘修正，改過的標「改過」。
 */
function YesterdayTime({
  me: myId,
  tasks,
  timezone,
  today,
}: {
  me: string;
  tasks: Task[];
  timezone: string;
  today: string;
}) {
  const date = prevWorkday(today);
  const month = date.slice(0, 7);
  const days = useLoad(
    () => (myId ? api.worklogDays(myId, [month]) : Promise.resolve([])),
    ['doc'],
  );
  const plans = useLoad(() => api.plans(true), ['doc']);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  const profile = useLoad(api.myProfile, ['doc']);
  const [open, setOpen] = useState(false);
  const { error, attempt } = useAction();
  const saved = (days.data ?? []).find((d) => d.date === date) ?? null;
  const [draft, setDraft] = useState<WorkEntry[] | null>(null);
  const reloadDays = days.reload;
  // 還沒整理過：從計時片段整理一次並寫入
  useEffect(() => {
    if (!myId || !days.data || saved || !plans.data || !dirs.data || !profile.data) return;
    const goalIds = new Set(dirs.data.teamGoals.map((g) => g.id));
    const from = Date.parse(`${date}T00:00:00Z`) - 86_400_000;
    void api
      .timerSegments(from, from + 3 * 86_400_000)
      .then((segs) => {
        const entries = entriesFromSegments(
          segs,
          date,
          timezone,
          (r) => {
            if (r.kind !== 'task') return null;
            const task = tasks.find((x) => x.id === r.task && x.team === r.team);
            return task ? projectOf(task, plans.data ?? [], goalIds) : null;
          },
          workMinutesOf(date, profile.data?.workHours),
          t('time.other'),
        );
        if (entries.length === 0) return;
        return api.setWorklogDay(date, { date, entries, updatedAt: 0 }).then(() => reloadDays());
      })
      .catch(() => undefined);
  }, [
    myId,
    days.data,
    saved,
    plans.data,
    dirs.data,
    profile.data,
    date,
    timezone,
    tasks,
    reloadDays,
  ]);
  const entries = draft ?? saved?.entries ?? [];
  const total = entries.reduce((n, e) => n + e.minutes, 0);
  const label = (e: WorkEntry) =>
    e.ref.kind === 'task'
      ? e.ref.title
      : e.ref.kind === 'meeting'
        ? t('time.meeting')
        : e.ref.title;
  const bump = (i: number, d: number) =>
    setDraft(
      entries.map((e, j) =>
        j === i ? { ...e, minutes: Math.max(0, round15(e.minutes + d)), source: 'edited' } : e,
      ),
    );
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel>{t('time.yesterday', { date: date.slice(5) })}</SectionLabel>
        <span className="text-xs text-muted">{t('time.total', { t: hm(total) })}</span>
        <span className="flex-1" />
        <LinkButton className="text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('time.collapse') : t('time.edit')}
        </LinkButton>
      </div>
      {open && (
        <>
          {entries.length === 0 && <p className="text-xs text-muted">{t('time.none')}</p>}
          <ul className="flex flex-col gap-1">
            {entries.map((e, i) => (
              <li key={`${refKey(e.ref)}-${i}`} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{label(e)}</span>
                <IconButton size="sm" label={t('time.minus')} onClick={() => bump(i, -15)}>
                  −
                </IconButton>
                <span className="w-12 text-center font-mono tabular-nums">{hm(e.minutes)}</span>
                <IconButton size="sm" label={t('time.plus')} onClick={() => bump(i, 15)}>
                  +
                </IconButton>
                <span className="w-10 text-xs text-muted">
                  {e.source === 'edited'
                    ? t('time.edited')
                    : e.source === 'manual'
                      ? t('time.manual')
                      : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs text-muted">{t('time.privacy')}</p>
            <Button
              size="sm"
              disabled={!draft}
              onClick={async () => {
                if (
                  await attempt(() =>
                    api.setWorklogDay(date, {
                      date,
                      entries: entries.filter((e) => e.minutes > 0),
                      updatedAt: 0,
                    }),
                  )
                ) {
                  setDraft(null);
                  days.reload();
                }
              }}
            >
              {t('common.save')}
            </Button>
          </div>
          <ErrorText message={error} />
        </>
      )}
    </Card>
  );
}
