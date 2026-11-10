/**
 * 每日任務（原每日 Scrum；ui-spec「Scrum」→「工作 › 今天」，D60；technical-design §16.12 v0.34）：
 * 草稿由任務紀錄產生，卡住了引用任務上未解決的紀錄。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type MemberView,
  type ScrumBlocked,
  type ScrumInput,
  type ScrumRef,
  type ScrumReport,
  type Task,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { effectiveTimezone } from './profile-utils';
import { formatTime, t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  addDays,
  blockedOf,
  dayStartMs,
  doneFromLogs,
  doneSince,
  isWorkday,
  mergeRefs,
  prevWorkday,
  refKey,
  shouldRemind,
  teamStatus,
  todayPlan,
  type MemberScrumStatus,
} from './scrum-utils';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  IconButton,
  Pressable,
  Select,
  TextInput,
  useAction,
} from './ui';

interface Props {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
}

const empty = (date: string): ScrumInput => ({
  date,
  done: [],
  today: [],
  blockers: [],
  blocked: [],
  note: '',
});

export function Scrum({ members, teams, tasks, focusId, timezone }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const today = periodsAt(now, timezone).day;
  const [offset, setOffset] = useState(0);
  const date = addDays(today, offset);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me));
  const [team, setTeam] = useState<string | null>(null);
  const teamId = team ?? myTeams[0]?.id ?? '';
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-3 wide:grid-cols-[minmax(0,1fr)_420px] wide:gap-4">
      <PageHead
        title={t('scrum.title')}
        subtitle={`${date}（${t(`scrum.weekday.${new Date(`${date}T00:00:00Z`).getUTCDay()}` as MessageKey)}）`}
        actions={
          <div className="flex items-center gap-1">
            <IconButton
              variant="secondary"
              label={t('goals.prevDay')}
              onClick={() => setOffset((o) => o - 1)}
            >
              ◀
            </IconButton>
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(0)}>
              {t('goals.today')}
            </Button>
            <IconButton
              variant="secondary"
              label={t('goals.nextDay')}
              disabled={offset >= 0}
              onClick={() => setOffset((o) => Math.min(0, o + 1))}
            >
              ▶
            </IconButton>
          </div>
        }
      />
      <MyScrum
        key={date}
        date={date}
        editable={date === today}
        members={members}
        tasks={tasks}
        focusId={focusId}
        timezone={timezone}
        me={me}
      />
      <TeamOverview
        teams={myTeams}
        teamId={teamId}
        onTeam={setTeam}
        members={members}
        date={date}
      />
    </div>
  );
}

function MyScrum({
  date,
  editable,
  members,
  tasks,
  focusId,
  timezone,
  me,
}: {
  date: string;
  editable: boolean;
  members: MemberView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
  me: string;
}) {
  const mine = useLoad(() => api.scrumMine(date), ['doc', 'org']);
  const logs = useLoad(() => api.myLogsSince(dayStartMs(prevWorkday(date))), ['doc']);
  // 草稿（D60）：昨天以來的紀錄 + 沒有紀錄的完成項、今天要做、卡住了
  const draftFrom = (): ScrumInput => ({
    ...empty(date),
    done: mergeRefs(
      doneFromLogs(logs.data ?? [], date, timezone),
      doneSince(tasks, me, date, timezone).filter(
        (r) => r.kind !== 'task' || !(logs.data ?? []).some((l) => l.task === r.taskId),
      ),
    ),
    today: todayPlan(tasks, me, focusId, date, timezone),
    blocked: blockedOf(tasks, me),
  });
  const [form, setForm] = useState<ScrumInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<'draft' | 'submitted' | null>(null);
  const { busy, error, attempt } = useAction();
  // 第一次讀到資料時：草稿優先，其次已送出的內容
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !mine.data || (editable && !logs.data)) return;
    inited.current = true;
    const d = mine.data;
    let v: ScrumInput = empty(date);
    if (d.draft) {
      try {
        v = { ...empty(date), ...(JSON.parse(d.draft) as ScrumInput), date };
      } catch {
        /* 草稿格式錯誤時忽略 */
      }
    } else if (d.report) {
      v = {
        date,
        done: d.report.done,
        today: d.report.today,
        blockers: [],
        blocked: d.report.blocked,
        note: d.report.note ?? '',
      };
    } else if (editable) {
      v = draftFrom();
    }
    setForm(v);
    // draftFrom 只在第一次讀到資料時使用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data, logs.data, date, editable]);
  const v = form ?? empty(date);
  const set = (p: Partial<ScrumInput>) => {
    setForm({ ...v, ...p });
    setDirty(true);
    setSaved(null);
  };
  const submitted = mine.data?.report ?? null;
  const notifyNames = (mine.data?.notify ?? [])
    .map((id) => members.find((m) => m.id === id)?.name)
    .filter(Boolean)
    .join('、');

  if (!editable) {
    return (
      <Card className="scroll-panel flex min-h-0 flex-col gap-3">
        <h2 className="font-bold">{t('scrum.mine')}</h2>
        {submitted ? (
          <ReportView report={submitted} />
        ) : (
          <p className="text-sm text-muted">{t('scrum.notSubmitted')}</p>
        )}
      </Card>
    );
  }
  return (
    <Card className="scroll-panel flex min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-bold">{t('scrum.mine')}</h2>
        {submitted && (
          <span className="text-xs text-muted">
            {t('scrum.submittedAt', { time: formatTime(submitted.updatedAt) })}
          </span>
        )}
      </div>
      <RefSection
        title={t('scrum.done')}
        items={v.done}
        onChange={(done) => set({ done })}
        action={
          <Button
            variant="secondary"
            className="h-8 px-3 py-0 text-xs"
            onClick={() => set({ done: mergeRefs(v.done, draftFrom().done) })}
          >
            {t('scrum.fromTasks')}
          </Button>
        }
      />
      <RefSection
        title={t('scrum.today')}
        items={v.today}
        onChange={(today) => set({ today })}
        action={
          <Button
            variant="secondary"
            className="h-8 px-3 py-0 text-xs"
            onClick={() =>
              set({ today: mergeRefs(v.today, todayPlan(tasks, me, focusId, date, timezone)) })
            }
          >
            {t('scrum.fromPlan')}
          </Button>
        }
      />
      <BlockedSection
        items={v.blocked}
        onChange={(blocked) => set({ blocked })}
        hint={
          v.blocked.length > 0 && notifyNames
            ? t('scrum.notify', { names: notifyNames })
            : t('scrum.blocked.hint')
        }
      />
      <TextInput
        aria-label={t('scrum.note')}
        placeholder={t('scrum.note.placeholder')}
        maxLength={200}
        value={v.note ?? ''}
        onChange={(e) => set({ note: e.target.value })}
      />
      <ErrorText message={error ?? mine.error ?? logs.error} />
      <div className="mt-auto flex items-center justify-end gap-2">
        {saved && (
          <span role="status" className="text-xs text-st-online-text">
            {saved === 'draft' ? t('scrum.draftSaved') : t('scrum.sent')}
          </span>
        )}
        <Button
          variant="secondary"
          disabled={busy || !dirty}
          onClick={async () => {
            if (await attempt(() => api.scrumDraftSet(date, JSON.stringify(v)))) {
              setDirty(false);
              setSaved('draft');
            }
          }}
        >
          {t('scrum.saveDraft')}
        </Button>
        <Button
          disabled={busy || (v.done.length === 0 && v.today.length === 0 && v.blocked.length === 0)}
          onClick={async () => {
            if (await attempt(() => api.scrumSubmit(v))) {
              setDirty(false);
              setSaved('submitted');
              mine.reload();
            }
          }}
        >
          {submitted ? t('scrum.update') : t('scrum.submit')}
        </Button>
      </div>
    </Card>
  );
}

function RefSection({
  title,
  items,
  onChange,
  action,
}: {
  title: string;
  items: ScrumRef[];
  onChange: (v: ScrumRef[]) => void;
  action: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((r, i) => (
          <li
            key={refKey(r)}
            className="flex items-center justify-between gap-2 rounded-control bg-bg px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              {r.kind !== 'text' && (
                <Badge>{t(r.kind === 'task' ? 'scrum.kind.task' : 'scrum.kind.plan')}</Badge>
              )}
              <span className="truncate">{r.title}</span>
            </span>
            <IconButton
              size="sm"
              label={t('scrum.remove', { title: r.title })}
              className="hover:text-danger"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ×
            </IconButton>
          </li>
        ))}
      </ul>
      <AddLine
        label={t('scrum.addItem', { section: title })}
        onAdd={(text) => onChange(mergeRefs(items, [{ kind: 'text', title: text }]))}
      />
    </section>
  );
}

function BlockedSection({
  items,
  onChange,
  hint,
}: {
  items: ScrumBlocked[];
  onChange: (v: ScrumBlocked[]) => void;
  hint?: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('scrum.blockers')}</h3>
      {items.length === 0 && <p className="text-xs text-muted">{t('scrum.blocked.empty')}</p>}
      <ul className="flex flex-col gap-1">
        {items.map((b, i) => (
          <li
            key={`${b.log ?? i}`}
            className="flex items-center justify-between gap-2 rounded-control border border-warning/50 bg-warning/10 px-3 py-1.5 text-sm"
          >
            <span className="min-w-0 truncate">
              {b.title && <strong className="font-semibold">{b.title}：</strong>}
              {b.text}
            </span>
            <IconButton
              size="sm"
              label={t('scrum.remove', { title: b.title || b.text })}
              className="hover:text-danger"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ×
            </IconButton>
          </li>
        ))}
      </ul>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </section>
  );
}

function AddLine({ label, onAdd }: { label: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const s = text.trim();
    if (!s) return;
    onAdd(s.slice(0, 200));
    setText('');
  };
  return (
    <TextInput
      value={text}
      maxLength={200}
      placeholder={label}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          add();
        }
      }}
      onBlur={add}
      className="border-dashed"
    />
  );
}

function ReportView({ report }: { report: ScrumReport }) {
  const list = (items: ScrumRef[]) =>
    items.length === 0 ? (
      <p className="text-xs text-muted">—</p>
    ) : (
      <ul className="list-disc pl-5 text-sm">
        {items.map((r) => (
          <li key={refKey(r)}>{r.title}</li>
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold text-muted">{t('scrum.done')}</h3>
        {list(report.done)}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-muted">{t('scrum.today')}</h3>
        {list(report.today)}
      </div>
      {report.blocked.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-warning">{t('scrum.blockers')}</h3>
          <ul className="list-disc pl-5 text-sm">
            {report.blocked.map((b, i) => (
              <li key={b.log ?? i}>
                {b.title && <strong className="font-semibold">{b.title}：</strong>}
                {b.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.note && <p className="text-sm text-muted">{report.note}</p>}
    </div>
  );
}

const STATUS_CLASS: Record<MemberScrumStatus, string> = {
  submitted: 'text-st-online-text',
  missing: 'text-warning',
  offday: 'text-muted',
};
const STATUS_ICON: Record<MemberScrumStatus, string> = {
  submitted: '✓',
  missing: '!',
  offday: '–',
};

function TeamOverview({
  teams,
  teamId,
  onTeam,
  members,
  date,
}: {
  teams: TeamView[];
  teamId: string;
  onTeam: (id: string) => void;
  members: MemberView[];
  date: string;
}) {
  const reports = useLoad(
    () => (teamId ? api.scrumTeam(teamId, date, date) : Promise.resolve([])),
    ['doc', 'org'],
  );
  const key = `${teamId}|${date}`;
  const last = useRef(key);
  const reload = reports.reload;
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      reload();
    }
  }, [key, reload]);
  const [open, setOpen] = useState<string | null>(null);
  const team = teams.find((x) => x.id === teamId);
  const people = members.filter((m) => team?.members.includes(m.id));
  const rows = teamStatus(people, reports.data ?? [], date);
  const missing = rows.filter((r) => r.status === 'missing').length;
  return (
    <Card className="scroll-panel flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">{t('scrum.team')}</h2>
        {teams.length > 1 && (
          <Select
            size="sm"
            value={teamId}
            aria-label={t('scrum.team')}
            onChange={(e) => onTeam(e.target.value)}
          >
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <p className="text-xs text-muted">
        {isWorkday(date)
          ? t('scrum.team.summary', { missing, total: rows.length })
          : t('scrum.offday')}
      </p>
      <ErrorText message={reports.error} />
      <ul className="flex flex-col divide-y divide-line">
        {rows.map(({ member, status, report }) => (
          <li key={member.id} className="py-2">
            <Pressable
              className="flex w-full items-center justify-between gap-2 rounded-sm text-sm disabled:opacity-100"
              aria-expanded={open === member.id}
              disabled={!report}
              onClick={() => setOpen(open === member.id ? null : member.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={`w-4 text-center font-bold ${STATUS_CLASS[status]}`}>
                  {STATUS_ICON[status]}
                </span>
                <span className="truncate font-medium">
                  {member.isMe ? t('goals.owner.me') : member.name}
                </span>
              </span>
              <span className={`shrink-0 text-xs ${STATUS_CLASS[status]}`}>
                {status === 'submitted' && report
                  ? t('scrum.counts', { done: report.done.length, today: report.today.length })
                  : t(`scrum.status.${status}` as MessageKey)}
              </span>
            </Pressable>
            {report && report.blocked.length > 0 && (
              <p className="mt-1 flex items-start gap-1 pl-6 text-xs text-warning">
                <span aria-hidden>⚠</span>
                {report.blocked.map((b) => (b.title ? `${b.title}：${b.text}` : b.text)).join('；')}
              </p>
            )}
            {open === member.id && report && (
              <div className="mt-2 pl-6">
                <ReportView report={report} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Scrum 提醒（technical-design §16.12、§16.17 v0.31）：本人的工作日、本人時區的提醒時間、
 * 尚未送出時通知一次。日期仍依組織時區（送出的 Scrum 以組織日期記錄）。
 */
export function useScrumReminder(orgTimezone: string | null) {
  const reminder = useLoad(api.scrumReminder, ['org']);
  const profile = useLoad(api.myProfile, ['doc']);
  const time = reminder.data ? (reminder.data.mine ?? reminder.data.org) : null;
  const tz = effectiveTimezone(profile.data);
  const days = (profile.data?.workHours.days ?? []).join(',');
  useEffect(() => {
    if (!orgTimezone || !time || !profile.data) return;
    const workDays = days ? days.split(',').map(Number) : [];
    const check = () => {
      const now = Date.now();
      if (shouldRemind(now, tz, time, workDays)) {
        void api
          .scrumRemind(
            periodsAt(now, orgTimezone).day,
            t('scrum.remind.title'),
            t('scrum.remind.body'),
          )
          .catch(() => undefined);
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [orgTimezone, time, tz, days, profile.data]);
}
