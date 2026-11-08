/** 每日 Scrum（ui-spec「Scrum」，feature-plan §5.4；technical-design §16.12）。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type MemberView,
  type ScrumInput,
  type ScrumRef,
  type ScrumReport,
  type Task,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { formatTime, t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  addDays,
  doneSince,
  isWorkday,
  mergeRefs,
  refKey,
  shouldRemind,
  teamStatus,
  todayPlan,
  type MemberScrumStatus,
} from './scrum-utils';
import { Button, Card, ErrorText, useAction } from './ui';

interface Props {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
}

const empty = (date: string): ScrumInput => ({ date, done: [], today: [], blockers: [] });

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
            <Button
              variant="secondary"
              className="h-9 px-3 py-0"
              aria-label={t('goals.prevDay')}
              onClick={() => setOffset((o) => o - 1)}
            >
              ◀
            </Button>
            <Button
              variant="secondary"
              className="h-9 px-3 py-0"
              disabled={offset === 0}
              onClick={() => setOffset(0)}
            >
              {t('goals.today')}
            </Button>
            <Button
              variant="secondary"
              className="h-9 px-3 py-0"
              aria-label={t('goals.nextDay')}
              disabled={offset >= 0}
              onClick={() => setOffset((o) => Math.min(0, o + 1))}
            >
              ▶
            </Button>
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
  const plans = useLoad(() => api.plans(true), ['doc']);
  const [form, setForm] = useState<ScrumInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<'draft' | 'submitted' | null>(null);
  const { busy, error, attempt } = useAction();
  // 第一次讀到資料時：草稿優先，其次已送出的內容
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !mine.data) return;
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
        blockers: d.report.blockers.map((b) => b.text),
      };
    }
    setForm(v);
  }, [mine.data, date]);
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
  const myPlans = plans.data ?? [];

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
            onClick={() =>
              set({ done: mergeRefs(v.done, doneSince(tasks, myPlans, me, date, timezone)) })
            }
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
              set({ today: mergeRefs(v.today, todayPlan(tasks, myPlans, focusId, date, timezone)) })
            }
          >
            {t('scrum.fromPlan')}
          </Button>
        }
      />
      <TextSection
        title={t('scrum.blockers')}
        items={v.blockers}
        onChange={(blockers) => set({ blockers })}
        hint={
          v.blockers.length > 0 && notifyNames
            ? t('scrum.notify', { names: notifyNames })
            : undefined
        }
      />
      <ErrorText message={error ?? mine.error} />
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
          disabled={
            busy || (v.done.length === 0 && v.today.length === 0 && v.blockers.length === 0)
          }
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
                <span className="shrink-0 rounded-full border border-line px-1.5 text-[11px] text-muted">
                  {t(r.kind === 'task' ? 'scrum.kind.task' : 'scrum.kind.plan')}
                </span>
              )}
              <span className="truncate">{r.title}</span>
            </span>
            <button
              type="button"
              aria-label={t('scrum.remove', { title: r.title })}
              className="shrink-0 text-muted hover:text-danger"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ×
            </button>
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

function TextSection({
  title,
  items,
  onChange,
  hint,
}: {
  title: string;
  items: string[];
  onChange: (v: string[]) => void;
  hint?: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="flex flex-col gap-1">
        {items.map((b, i) => (
          <li
            key={`${i}-${b}`}
            className="flex items-center justify-between gap-2 rounded-control border border-danger/40 px-3 py-1.5 text-sm"
          >
            <span className="truncate">{b}</span>
            <button
              type="button"
              aria-label={t('scrum.remove', { title: b })}
              className="shrink-0 text-muted hover:text-danger"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <AddLine
        label={t('scrum.addItem', { section: title })}
        onAdd={(text) => onChange(items.includes(text) ? items : [...items, text])}
      />
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
    <input
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
      className="rounded-control border border-dashed border-line bg-surface px-3 py-1.5 text-sm"
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
      {report.blockers.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-danger">{t('scrum.blockers')}</h3>
          <ul className="list-disc pl-5 text-sm text-danger">
            {report.blockers.map((b, i) => (
              <li key={i}>{b.text}</li>
            ))}
          </ul>
        </div>
      )}
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
          <select
            value={teamId}
            aria-label={t('scrum.team')}
            onChange={(e) => onTeam(e.target.value)}
            className="rounded-control border border-line bg-surface px-2 py-1 text-sm"
          >
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
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
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left text-sm"
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
            </button>
            {report && report.blockers.length > 0 && (
              <p className="mt-1 flex items-start gap-1 pl-6 text-xs text-danger">
                <span aria-hidden>⚠</span>
                {report.blockers.map((b) => b.text).join('；')}
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

/** Scrum 提醒（technical-design §16.12）：工作日、到提醒時間、尚未送出時通知一次。 */
export function useScrumReminder(timezone: string | null) {
  const reminder = useLoad(api.scrumReminder, ['org']);
  const time = reminder.data ? (reminder.data.mine ?? reminder.data.org) : null;
  useEffect(() => {
    if (!timezone || !time) return;
    const check = () => {
      const now = Date.now();
      if (shouldRemind(now, timezone, time)) {
        void api
          .scrumRemind(
            periodsAt(now, timezone).day,
            t('scrum.remind.title'),
            t('scrum.remind.body'),
          )
          .catch(() => undefined);
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [timezone, time]);
}
