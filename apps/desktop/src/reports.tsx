/** 日 / 週報（ui-spec「報表」，feature-plan §5.5、D32、D16；technical-design §16.13）。 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  type MemberView,
  type Report,
  type ReportInput,
  type ReportKind,
  type ReportSections,
  type PlanView,
  type Task,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { effectiveTimezone } from './profile-utils';
import { formatTime, t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import { printMarkdown } from './print';
import { useMyReport } from './report-data';
import { ExportDialog } from './report-export';
import { SixSections } from './report-view';
import {
  carryCandidates,
  mergeTeam,
  nextMondaySameTime,
  periodOf,
  shiftPeriod,
  toMarkdown,
  type ReportLabels,
} from './reports-utils';
import { shouldRemind, weekday } from './scrum-utils';
import {
  Button,
  Card,
  Checkbox,
  ErrorText,
  IconButton,
  Markdown,
  Pressable,
  Select,
  useAction,
  Switch,
} from './ui';

const SECTIONS: (keyof ReportSections)[] = ['progress', 'okr', 'attendance', 'next'];

function labels(): ReportLabels {
  return {
    done: t('report.gen.done'),
    doing: t('report.gen.doing'),
    blockers: t('report.gen.blockers'),
    none: t('report.gen.none'),
    weekDone: t('report.gen.weekDone'),
    attendancePending: t('report.gen.attendance'),
    sections: {
      progress: t('report.section.progress'),
      okr: t('report.section.okr'),
      attendance: t('report.section.attendance'),
      next: t('report.section.next'),
    },
  };
}

const titleOf = (kind: ReportKind, period: string) =>
  t(kind === 'daily' ? 'report.title.daily' : 'report.title.weekly', { period });

interface Props {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  timezone: string;
}

export function Reports({ members, teams, tasks, timezone }: Props) {
  // 日報已由每日任務取代（D60），這裡只剩週報
  const kind: ReportKind = 'weekly';
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const [shift, setShift] = useState(0);
  const period = shiftPeriod(kind, periodOf(kind, today), shift);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me));
  const [team, setTeam] = useState<string | null>(null);
  const teamId = team ?? myTeams[0]?.id ?? '';
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const [exporting, setExporting] = useState(false);
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-3 wide:grid-cols-[minmax(0,1fr)_420px] wide:gap-4">
      <PageHead
        title={t('report.page')}
        subtitle={titleOf(kind, period)}
        actions={
          <>
            <div className="flex items-center gap-1">
              <IconButton
                variant="secondary"
                label={t('report.prev')}
                onClick={() => setShift((s) => s - 1)}
              >
                ◀
              </IconButton>
              <Button variant="secondary" disabled={shift === 0} onClick={() => setShift(0)}>
                {t('report.thisWeek')}
              </Button>
              <IconButton
                variant="secondary"
                label={t('report.next')}
                disabled={shift >= 0}
                onClick={() => setShift((s) => Math.min(0, s + 1))}
              >
                ▶
              </IconButton>
            </div>
          </>
        }
      />
      <MyReport
        key={`${kind}:${period}`}
        kind={kind}
        period={period}
        me={me}
        myTeams={myTeams}
        tasks={tasks}
        timezone={timezone}
        onExport={() => setExporting(true)}
      />
      {exporting && (
        <ExportDialog
          initialKind="weekly"
          members={members}
          teams={teams}
          tasks={tasks}
          timezone={timezone}
          onClose={() => setExporting(false)}
        />
      )}
      <TeamReports
        teams={myTeams}
        teamId={teamId}
        onTeam={setTeam}
        members={members}
        kind={kind}
        period={period}
        nameOf={nameOf}
      />
    </div>
  );
}

function MyReport({
  kind,
  period,
  me,
  myTeams,
  tasks,
  timezone,
  onExport,
}: {
  kind: ReportKind;
  period: string;
  me: string;
  myTeams: TeamView[];
  tasks: Task[];
  timezone: string;
  onExport: () => void;
}) {
  const mine = useLoad(() => api.reportMine(kind, period), ['doc', 'org']);
  const plans = useLoad(() => api.plans(true), ['doc']);
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const [skipCarry, setSkipCarry] = useState<string[]>([]);
  const candidates = carryCandidates(tasks, me, period, timezone, plans.data ?? []);
  const carried = candidates.filter((x) => !skipCarry.includes(x.id));
  const six = useMyReport('weekly', period, me, tasks, timezone, carried.length);
  const [form, setForm] = useState<ReportInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const { busy, error, attempt } = useAction();
  const allTeams = myTeams.map((x) => x.id);
  // 初始化：草稿 → 已發佈（v2）→ 依資料產生（資料都讀到之後）
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !mine.data || !plans.data || !six.ready) return;
    inited.current = true;
    const d = mine.data;
    let v: ReportInput | null = null;
    if (d.draft) {
      try {
        v = JSON.parse(d.draft) as ReportInput;
      } catch {
        /* 草稿格式錯誤時忽略 */
      }
    }
    if (v && !v.data) v = null;
    if (!v && d.report?.data) {
      v = {
        kind,
        period,
        sections: d.report.sections,
        publishedTo: d.report.publishedTo,
        generatedAt: d.report.generatedAt,
        data: d.report.data,
      };
    }
    setForm(
      v ?? {
        kind,
        period,
        sections: EMPTY_SECTIONS,
        publishedTo: d.report?.publishedTo ?? allTeams,
        generatedAt: Date.now(),
        data: six.build(),
      },
    );
    // six.build 依賴的資料都已在條件中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data, plans.data, six.ready]);
  if (!form?.data) {
    return (
      <Card className="flex items-center justify-center text-sm text-muted">
        <ErrorText message={six.error ?? mine.error} />
        {t('common.loading')}
      </Card>
    );
  }
  const data = form.data;
  const set = (p: Partial<ReportInput>) => {
    setForm({ ...form, ...p });
    setDirty(true);
    setStatus(null);
  };
  const regen = () => {
    const fresh = six.build();
    // 改過的摘要不覆蓋（D61）
    set({
      data: data.summaryEdited ? { ...fresh, summary: data.summary, summaryEdited: true } : fresh,
      generatedAt: Date.now(),
    });
  };
  const published = mine.data?.report ?? null;
  const goals = dirs.data?.teamGoals ?? [];
  // 舊版讀者看得到的四欄（v1 相容）
  const withSections = (d: typeof data): ReportInput => ({
    ...form,
    data: {
      ...d,
      plan: {
        ...d.plan,
        tasks: { ...d.plan.tasks, carried: published ? d.plan.tasks.carried : carried.length },
      },
    },
    sections: { progress: d.doneMd, okr: d.summary, attendance: '', next: d.nextMd },
  });
  return (
    <Card className="scroll-panel flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{t('report.mine')}</h2>
        <span className="text-xs text-muted">
          {published
            ? t('report.publishedAt', { time: formatTime(published.publishedAt) })
            : t('report.draft')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {confirmRegen ? (
          <span className="flex items-center gap-2 text-xs">
            {t('rep.regen.confirm')}
            <Button
              size="sm"
              onClick={() => {
                regen();
                setConfirmRegen(false);
              }}
            >
              {t('report.regen')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRegen(false)}>
              {t('common.cancel')}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setConfirmRegen(true)}>
            {t('report.regen')}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onExport}>
          {t('exp.open')}
        </Button>
      </div>
      <SixSections data={data} goals={goals} onChange={(d) => set({ data: d })} />
      {!published && candidates.length > 0 && (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 text-xs text-muted">{t('report.carry')}</legend>
          {candidates.map((x) => (
            <Checkbox
              key={x.id}
              label={x.title}
              checked={!skipCarry.includes(x.id)}
              onChange={(e) =>
                setSkipCarry(
                  e.target.checked ? skipCarry.filter((y) => y !== x.id) : [...skipCarry, x.id],
                )
              }
            />
          ))}
          <p className="text-xs text-muted">{t('report.carry.hint')}</p>
        </fieldset>
      )}
      <fieldset className="flex flex-wrap items-center gap-3 text-sm">
        <legend className="mb-1 text-xs text-muted">{t('report.publishTo')}</legend>
        {myTeams.map((x) => (
          <Checkbox
            key={x.id}
            label={x.name}
            checked={form.publishedTo.includes(x.id)}
            onChange={(e) =>
              set({
                publishedTo: e.target.checked
                  ? [...form.publishedTo, x.id]
                  : form.publishedTo.filter((y) => y !== x.id),
              })
            }
          />
        ))}
      </fieldset>
      <p className="text-xs text-muted">{t('rep.publishPrivacy')}</p>
      <ErrorText message={error ?? mine.error} />
      <div className="mt-auto flex items-center justify-end gap-2">
        {status && (
          <span role="status" className="text-xs text-st-online-text">
            {status}
          </span>
        )}
        <Button
          variant="secondary"
          disabled={busy || !dirty}
          onClick={async () => {
            if (await attempt(() => api.reportDraftSet(kind, period, JSON.stringify(form)))) {
              setDirty(false);
              setStatus(t('scrum.draftSaved'));
            }
          }}
        >
          {t('scrum.saveDraft')}
        </Button>
        <Button
          disabled={busy || form.publishedTo.length === 0}
          onClick={async () => {
            const ok = await attempt(async () => {
              await api.reportPublish(withSections(data));
              if (!published) await carryOver(carried, period, plans.data ?? []);
            });
            if (ok) {
              setDirty(false);
              setStatus(t('report.published'));
              mine.reload();
            }
          }}
        >
          {published ? t('scrum.update') : t('report.publish')}
        </Button>
      </div>
    </Card>
  );
}

const EMPTY_SECTIONS = { progress: '', okr: '', attendance: '', next: '' };

/**
 * 延到下期（D61）：期限移到下週一同一時間；連到這週週目標的任務改連到下週同名的週目標，沒有時建立。
 */
async function carryOver(list: Task[], week: string, plans: PlanView[]) {
  const next = shiftPeriod('weekly', week, 1);
  const created = new Map<string, string>();
  for (const x of list) {
    let planItemId = x.planItemId;
    const goal = plans.find((p) => p.id === x.planItemId && p.period === week);
    if (goal) {
      const same = plans.find(
        (p) => p.mine && p.level === 'week' && p.period === next && p.title === goal.title,
      );
      planItemId =
        same?.id ??
        created.get(goal.title) ??
        (await api.savePlan({
          level: 'week',
          period: next,
          title: goal.title,
          parentId: null,
          krRef: null,
          done: false,
          progressOverride: null,
          keyResults: [],
          visibility: goal.visibility,
        }));
      created.set(goal.title, planItemId);
    }
    await api.updateTask(x.team, x.id, {
      title: x.title,
      assignee: x.assignee,
      status: x.status,
      dueAt: nextMondaySameTime(x.dueAt, Date.now()),
      steps: x.steps.map((s) => ({ id: s.id, title: s.title, assignee: s.assignee, done: s.done })),
      planItemId,
      teamGoalId: x.teamGoalId,
    });
  }
}

function TeamReports({
  teams,
  teamId,
  onTeam,
  members,
  kind,
  period,
  nameOf,
}: {
  teams: TeamView[];
  teamId: string;
  onTeam: (id: string) => void;
  members: MemberView[];
  kind: ReportKind;
  period: string;
  nameOf: (id: string) => string;
}) {
  const reports = useLoad(
    () => (teamId ? api.reportTeam(teamId, kind, period) : Promise.resolve([] as Report[])),
    ['doc', 'org'],
  );
  const key = `${teamId}|${kind}|${period}`;
  const last = useRef(key);
  const reload = reports.reload;
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      reload();
    }
  }, [key, reload]);
  const [open, setOpen] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);
  const { error, attempt } = useAction();
  const team = teams.find((x) => x.id === teamId);
  const people = members.filter((m) => team?.members.includes(m.id));
  const list = reports.data ?? [];
  const L = labels();
  const teamTitle = `${team?.name ?? ''} · ${titleOf(kind, period)}`;
  const mergedSections = mergeTeam(list, nameOf, L);
  const mergedMd = toMarkdown(teamTitle, mergedSections, L);
  return (
    <Card className="scroll-panel flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">{t('report.team')}</h2>
        {teams.length > 1 && (
          <Select
            size="sm"
            value={teamId}
            aria-label={t('report.team')}
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
        {t('report.team.summary', { published: list.length, total: people.length })}
      </p>
      <div className="flex flex-wrap gap-2 [&>button]:whitespace-nowrap">
        <Switch
          size="sm"
          className="h-8 pr-1"
          label={t('report.merged')}
          checked={merged}
          onChange={setMerged}
        />
        {merged && (
          <>
            <Button
              variant="secondary"
              className="h-8 px-3 py-0 text-xs"
              onClick={() => void attempt(() => api.exportText(`${teamTitle}.md`, mergedMd))}
            >
              {t('report.exportMd')}
            </Button>
            <Button
              variant="secondary"
              className="h-8 px-3 py-0 text-xs"
              onClick={() => printMarkdown(mergedMd)}
            >
              {t('report.print')}
            </Button>
          </>
        )}
      </div>
      <ErrorText message={error ?? reports.error} />
      {merged ? (
        <SectionsView sections={mergedSections} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {people.map((m) => {
            const r = list.find((x) => x.member === m.id);
            return (
              <li key={m.id} className="py-2">
                <Pressable
                  disabled={!r}
                  aria-expanded={open === m.id}
                  onClick={() => setOpen(open === m.id ? null : m.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-sm text-sm disabled:opacity-100"
                >
                  <span className="truncate font-medium">
                    {m.isMe ? t('goals.owner.me') : m.name}
                  </span>
                  <span className={`shrink-0 text-xs ${r ? 'text-st-online-text' : 'text-muted'}`}>
                    {r
                      ? t('report.publishedAt', { time: formatTime(r.publishedAt) })
                      : t('report.notPublished')}
                  </span>
                </Pressable>
                {open === m.id && r && (
                  <div className="mt-2">
                    <SectionsView sections={r.sections} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function SectionsView({ sections }: { sections: ReportSections }) {
  return (
    <div className="flex flex-col gap-3">
      {SECTIONS.map((k) => (
        <div key={k}>
          <h3 className="text-xs font-semibold text-muted">
            {t(`report.section.${k}` as MessageKey)}
          </h3>
          <div className="prose-hills text-sm">
            <Markdown>{sections[k]}</Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 週五提醒產生週報（technical-design §16.13；沿用 Scrum 提醒時間與本人的工作日、時區，§16.17）。 */
export function useWeeklyReportReminder(orgTimezone: string | null) {
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
      const day = periodsAt(now, orgTimezone).day;
      if (weekday(day) === 5 && shouldRemind(now, tz, time, workDays)) {
        void api
          .reportRemind(periodOf('weekly', day), t('report.remind.title'), t('report.remind.body'))
          .catch(() => undefined);
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [orgTimezone, time, tz, days, profile.data]);
}
