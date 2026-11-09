/** 日 / 週報（ui-spec「報表」，feature-plan §5.5、D32、D16；technical-design §16.13）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  api,
  type MemberView,
  type Report,
  type ReportInput,
  type ReportKind,
  type ReportSections,
  type ScrumReport,
  type Task,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { formatTime, t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  daysOf,
  generate,
  mergeTeam,
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
  SegmentedControl,
  Select,
  TextArea,
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
  const [kind, setKind] = useState<ReportKind>('weekly');
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const [shift, setShift] = useState(0);
  const period = shiftPeriod(kind, periodOf(kind, today), shift);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me));
  const [team, setTeam] = useState<string | null>(null);
  const teamId = team ?? myTeams[0]?.id ?? '';
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_340px] gap-3 wide:grid-cols-[minmax(0,1fr)_420px] wide:gap-4">
      <PageHead
        title={t('report.page')}
        subtitle={titleOf(kind, period)}
        actions={
          <>
            <SegmentedControl
              label={t('report.page')}
              value={kind}
              onChange={(k) => {
                setKind(k);
                setShift(0);
              }}
              options={(['daily', 'weekly'] as const).map((k) => ({
                value: k,
                label: t(`report.kind.${k}` as MessageKey),
              }))}
            />
            <div className="flex items-center gap-1">
              <IconButton
                variant="secondary"
                label={t('report.prev')}
                onClick={() => setShift((s) => s - 1)}
              >
                ◀
              </IconButton>
              <Button variant="secondary" disabled={shift === 0} onClick={() => setShift(0)}>
                {t(kind === 'daily' ? 'goals.today' : 'report.thisWeek')}
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
      />
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
}: {
  kind: ReportKind;
  period: string;
  me: string;
  myTeams: TeamView[];
  tasks: Task[];
  timezone: string;
}) {
  const mine = useLoad(() => api.reportMine(kind, period), ['doc', 'org']);
  const plans = useLoad(() => api.plans(true), ['doc']);
  const days = daysOf(kind, period);
  const scrum = useLoad(async () => {
    const out: ScrumReport[] = [];
    for (const tm of myTeams.slice(0, 1)) {
      out.push(...(await api.scrumTeam(tm.id, days[0]!, days[days.length - 1]!)));
    }
    return out;
  }, ['doc']);
  const [form, setForm] = useState<ReportInput | null>(null);
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const { busy, error, attempt } = useAction();
  const L = useMemo(() => labels(), []);
  const build = (): ReportSections =>
    generate({
      kind,
      period,
      me,
      tz: timezone,
      scrum: scrum.data ?? [],
      tasks,
      plans: plans.data ?? [],
      labels: L,
    });
  const allTeams = myTeams.map((x) => x.id);
  // 初始化：草稿 → 已發佈 → 自動產生（資料都讀到之後）
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !mine.data || !plans.data || !scrum.data) return;
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
    if (!v && d.report) {
      v = {
        kind,
        period,
        sections: d.report.sections,
        publishedTo: d.report.publishedTo,
        generatedAt: d.report.generatedAt,
      };
    }
    setForm(
      v ?? {
        kind,
        period,
        sections: build(),
        publishedTo: allTeams,
        generatedAt: Date.now(),
      },
    );
    // build 依賴的資料都已在條件中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.data, plans.data, scrum.data]);
  if (!form) {
    return (
      <Card className="flex items-center justify-center text-sm text-muted">
        {t('common.loading')}
      </Card>
    );
  }
  const set = (p: Partial<ReportInput>) => {
    setForm({ ...form, ...p });
    setDirty(true);
    setStatus(null);
  };
  const published = mine.data?.report ?? null;
  const md = toMarkdown(titleOf(kind, period), form.sections, L);
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
        <Button
          variant="secondary"
          className="h-8 px-3 py-0 text-xs"
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? t('kb.field.write') : t('kb.field.preview')}
        </Button>
        {confirmRegen ? (
          <span className="flex items-center gap-2 text-xs">
            {t('report.regen.confirm')}
            <Button
              className="h-8 px-3 py-0 text-xs"
              onClick={() => {
                set({ sections: build(), generatedAt: Date.now() });
                setConfirmRegen(false);
              }}
            >
              {t('report.regen')}
            </Button>
            <Button
              variant="secondary"
              className="h-8 px-3 py-0 text-xs"
              onClick={() => setConfirmRegen(false)}
            >
              {t('common.cancel')}
            </Button>
          </span>
        ) : (
          <Button
            variant="secondary"
            className="h-8 px-3 py-0 text-xs"
            onClick={() => setConfirmRegen(true)}
          >
            {t('report.regen')}
          </Button>
        )}
        <Button
          variant="secondary"
          className="h-8 px-3 py-0 text-xs"
          onClick={() =>
            void attempt(async () => {
              if (await api.exportText(`${titleOf(kind, period)}.md`, md))
                setStatus(t('report.exported'));
            })
          }
        >
          {t('report.exportMd')}
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 py-0 text-xs"
          onClick={() => printMarkdown(md)}
        >
          {t('report.print')}
        </Button>
      </div>
      {SECTIONS.map((k) => (
        <section key={k} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t(`report.section.${k}` as MessageKey)}</h3>
          {preview ? (
            <div className="prose-hills rounded-control border border-line p-3 text-sm">
              <Markdown>{form.sections[k]}</Markdown>
            </div>
          ) : (
            <TextArea
              value={form.sections[k]}
              aria-label={t(`report.section.${k}` as MessageKey)}
              rows={k === 'attendance' ? 2 : 5}
              onChange={(e) => set({ sections: { ...form.sections, [k]: e.target.value } })}
              className="font-mono text-xs"
            />
          )}
        </section>
      ))}
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
            if (await attempt(() => api.reportPublish(form))) {
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

/** 列印 / 存成 PDF：把 Markdown 轉成 HTML 放進列印區，呼叫系統列印對話框（可選「存成 PDF」）。 */
function printMarkdown(md: string) {
  const area = document.createElement('div');
  area.className = 'print-area prose-hills';
  // react-markdown 不轉譯原始 HTML（skipHtml），輸出可安全放入
  area.innerHTML = renderToStaticMarkup(<Markdown>{md}</Markdown>);
  document.body.appendChild(area);
  const done = () => {
    area.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  // 部分 WebView 不會觸發 afterprint
  setTimeout(done, 60_000);
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

/** 週五提醒產生週報（technical-design §16.13；沿用 Scrum 提醒時間）。 */
export function useWeeklyReportReminder(timezone: string | null) {
  const reminder = useLoad(api.scrumReminder, ['org']);
  const time = reminder.data ? (reminder.data.mine ?? reminder.data.org) : null;
  useEffect(() => {
    if (!timezone || !time) return;
    const check = () => {
      const now = Date.now();
      const day = periodsAt(now, timezone).day;
      if (weekday(day) === 5 && shouldRemind(now, timezone, time)) {
        void api
          .reportRemind(periodOf('weekly', day), t('report.remind.title'), t('report.remind.body'))
          .catch(() => undefined);
      }
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [timezone, time]);
}
