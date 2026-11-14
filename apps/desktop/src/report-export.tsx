/**
 * 匯出報告（ui-spec「工作 › 報告與匯出」v0.45，D61、D66；technical-design §16.13）：
 * 日 / 週 / 月 / 季 / 年 × 我自己 / 小組（負責人）/ 全公司（管理者）× 列印 / Markdown / CSV。
 * 小組與全公司只用已發佈的週報（專案層級）；「每人一節」只給負責人的小組範圍（D62）。
 * 視窗 ≥ 1440 px 時雙欄（左選項、右預覽），較窄時單欄、選項可收合（D66）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type DayLog,
  type MemberView,
  type ReportData,
  type ReportInput,
  type Task,
  type TeamGoal,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad, useMediaQuery } from './hooks';
import { t, type MessageKey } from './i18n';
import { printMarkdown } from './print';
import { useMyReport } from './report-data';
import {
  hours,
  mergeReports,
  monthsOf,
  periodDays,
  periodOfDay,
  PERIOD_KINDS,
  reportMarkdown,
  SECTION_KEYS,
  shiftKindPeriod,
  summaryOf,
  timeRows,
  timeShareRows,
  toCsv,
  weeksOf,
  worklogRows,
  type PeriodKind,
  type SectionKey,
} from './report-utils';
import { mdText, periodLabel, projectName, SixSections, summaryText } from './report-view';
import {
  Button,
  Dialog,
  DialogFooter,
  ErrorText,
  IconButton,
  LinkButton,
  OptionTile,
  SegmentedControl,
  Skeleton,
  Toast,
  ToggleChip,
  useAction,
  type ButtonSize,
} from './ui';

type Format = 'pdf' | 'md' | 'csv';

interface Loaded {
  data: ReportData;
  goals: TeamGoal[];
  /** 本人範圍：逐筆時間（CSV 明細） */
  worklog: DayLog[] | null;
  /** 每人一節（負責人的小組範圍） */
  people: { name: string; time: { project: string; minutes: number }[] }[];
}

interface ExportProps {
  initialKind: PeriodKind;
  /** `me` 或小組 id 或 `org` */
  initialScope?: string;
  /** 從週五收尾開啟：該期間與畫面上的週報（含尚未發佈的修改） */
  initialPeriod?: string;
  initialData?: ReportData;
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  timezone: string;
}

/** 匯出按鈕：開啟對話框，完成後顯示 Toast（ui-spec v0.45）。 */
export function ExportButton({
  label,
  size = 'sm',
  ...props
}: ExportProps & { label: string; size?: ButtonSize }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <Button size={size} variant="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <ExportDialog
          {...props}
          onClose={() => setOpen(false)}
          onDone={(msg) => {
            setOpen(false);
            setDone(msg);
          }}
        />
      )}
      {done && <Toast key={done} message={done} onClose={() => setDone(null)} />}
    </>
  );
}

const svg = (d: ReactNode) => (
  <svg
    viewBox="0 0 20 20"
    className="size-4.5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);
const ICON = {
  me: svg(
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4.5 16.5c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
    </>,
  ),
  team: svg(
    <>
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="13.5" cy="8.5" r="2" />
      <path d="M2.5 16c.6-2.6 2.6-4 5-4s4.4 1.4 5 4M12.5 12.2c2.2-.3 4.2.9 4.8 3.3" />
    </>,
  ),
  org: svg(
    <>
      <path d="M3.5 16.5V5.5l6-2.5v13.5M9.5 16.5V8l7 2.5v6M2.5 16.5h15" />
      <path d="M5.5 7.5h2M5.5 10.5h2M12 12h2" />
    </>,
  ),
  pdf: svg(
    <>
      <path d="M5.5 7.5V3.5h9v4M5.5 13.5h-2v-6h13v6h-2" />
      <path d="M5.5 11.5h9v5h-9z" />
    </>,
  ),
  md: svg(
    <>
      <path d="M5 2.5h7l3.5 3.5v11.5H5z" />
      <path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h5" />
    </>,
  ),
  csv: svg(
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M3 8h14M3 12.5h14M8 3.5v13" />
    </>,
  ),
};

const kindName = (k: PeriodKind) => t(`exp.kind.${k}` as MessageKey);
const PREVIEW_ROWS = 10;

export function ExportDialog({
  initialKind,
  initialScope = 'me',
  initialPeriod,
  initialData,
  members,
  teams,
  tasks,
  timezone,
  onClose,
  onDone,
}: ExportProps & { onClose: () => void; onDone: (message: string) => void }) {
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const isAdmin = Boolean(me?.isAdmin);
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const wide = useMediaQuery('(min-width: 1440px)');
  const [collapsed, setCollapsed] = useState(false);
  const [kind, setKind] = useState<PeriodKind>(initialKind);
  const current = periodOfDay(kind, today);
  const [period, setPeriod] = useState(initialPeriod ?? current);
  const leadOf = teams.filter((x) => x.leads.includes(meId));
  const [scope, setScope] = useState(initialScope === 'org' && !isAdmin ? 'me' : initialScope);
  const [sections, setSections] = useState<SectionKey[]>(SECTION_KEYS);
  const [perPerson, setPerPerson] = useState(false);
  const [format, setFormat] = useState<Format>('pdf');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { busy, error, attempt } = useAction();
  const days = periodDays(kind, period);
  const ongoing = days[days.length - 1]! >= today;
  const atCurrent = period >= current;
  const teamOf = teams.find((x) => x.id === scope) ?? null;
  const isTeam = scope !== 'me';
  const scopeName =
    scope === 'me' ? (me?.name ?? '') : scope === 'org' ? t('exp.scope.org') : (teamOf?.name ?? '');
  const label = periodLabel(kind, period);
  const title = t('exp.title', { name: scopeName, kind: kindName(kind), period: label });
  const fileBase = `${scopeName}-${kindName(kind)}-${period}`;
  const meta = [ongoing ? t('exp.asOf', { day: today }) : '', t('exp.by', { name: me?.name ?? '' })]
    .filter(Boolean)
    .join(' · ');
  const csv = format === 'csv';
  const needSection = !csv && sections.length === 0;
  const preset = initialData && kind === 'weekly' && period === initialPeriod ? initialData : null;

  const reset = () => setLoaded(null);
  const go = (n: number) => {
    setPeriod((p) => {
      const next = shiftKindPeriod(kind, p, n);
      return next > current ? current : next;
    });
    reset();
  };
  const projectOf = (p: string) => projectName(p, loaded?.goals ?? []);
  const csvHeader = loaded?.worklog
    ? [
        t('exp.csv.date'),
        t('exp.csv.item'),
        t('exp.csv.project'),
        t('exp.csv.minutes'),
        t('exp.csv.source'),
      ]
    : [t('exp.csv.project'), t('exp.csv.minutes'), t('exp.csv.share')];
  const csvRows = !loaded
    ? []
    : loaded.worklog
      ? worklogRows(loaded.worklog, days, projectOf, () => t('time.meeting'))
      : timeShareRows(loaded.data.time, projectOf);

  const markdown = (l: Loaded) => {
    const extra =
      perPerson && l.people.length
        ? [
            `## ${t('exp.perPerson')}`,
            '',
            ...l.people.flatMap((p) => [
              `### ${p.name}`,
              '',
              ...(p.time.length
                ? p.time.map(
                    (r) =>
                      `- ${projectName(r.project, l.goals)}：${hours(r.minutes)} ${t('rep.hoursUnit')}`,
                  )
                : [`- ${t('report.gen.none')}`]),
              '',
            ]),
          ]
        : [];
    return reportMarkdown(title, meta, l.data, sections, mdText(l.goals), extra);
  };

  const run = () =>
    void attempt(async () => {
      if (!loaded) return;
      if (format === 'pdf') {
        printMarkdown(markdown(loaded));
        onClose();
        return;
      }
      const name = `${fileBase}.${format}`;
      const ok =
        format === 'md'
          ? await api.exportText(name, markdown(loaded))
          : await api.exportText(name, toCsv([csvHeader, ...csvRows]));
      if (ok) onDone(t('exp.done', { name }));
    });

  const scopeOptions = [
    {
      value: 'me',
      title: t('exp.scope.me'),
      description: t('exp.scope.me.desc'),
      icon: ICON.me,
    },
    ...leadOf.map((x) => ({
      value: x.id,
      title: x.name,
      description: t('exp.scope.team.desc', {
        n: new Set([...x.members, ...x.leads]).size,
      }),
      icon: ICON.team,
    })),
    ...(isAdmin
      ? [
          {
            value: 'org',
            title: t('exp.scope.org'),
            description: t('exp.scope.org.desc'),
            icon: ICON.org,
          },
        ]
      : []),
  ];
  // 雙欄時左欄窄，格式卡只放名稱，說明顯示在下方
  const formatOptions = (['pdf', 'md', 'csv'] as const).map((f) => ({
    value: f,
    title: t(`exp.format.${f}`),
    description: wide ? undefined : t(`exp.format.${f}.desc`),
    icon: ICON[f],
  }));
  const legend = (text: string) => <span className="text-xs font-bold text-muted">{text}</span>;

  const options = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {legend(t('exp.kind'))}
        <SegmentedControl
          className="self-start"
          label={t('exp.kind')}
          options={PERIOD_KINDS.map((k) => ({ value: k, label: kindName(k) }))}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setPeriod(periodOfDay(k, today));
            reset();
          }}
        />
        <div className="flex items-center gap-2 text-sm">
          <IconButton size="sm" variant="secondary" label={t('report.prev')} onClick={() => go(-1)}>
            ◀
          </IconButton>
          <strong className="min-w-0 truncate">{label}</strong>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('report.next')}
            disabled={atCurrent}
            onClick={() => go(1)}
          >
            ▶
          </IconButton>
          {ongoing && <span className="text-xs text-muted">{t('exp.asOf', { day: today })}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {legend(t('exp.scope'))}
        <OptionTile
          label={t('exp.scope')}
          options={scopeOptions}
          value={scope}
          columns={wide ? 1 : (Math.min(3, scopeOptions.length) as 1 | 2 | 3)}
          onChange={(v) => {
            setScope(v);
            setPerPerson(false);
            reset();
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        {legend(t('exp.format'))}
        <OptionTile
          label={t('exp.format')}
          options={formatOptions}
          value={format}
          columns={3}
          onChange={setFormat}
        />
        {wide && <p className="text-xs text-muted">{t(`exp.format.${format}.desc`)}</p>}
      </div>
      <div className="flex flex-col gap-2">
        {legend(t('exp.content'))}
        <div role="group" aria-label={t('exp.content')} className="flex flex-wrap gap-1.5">
          {SECTION_KEYS.map((k) => (
            <ToggleChip
              key={k}
              disabled={csv}
              title={csv ? t('exp.csvOnly') : undefined}
              checked={!csv && sections.includes(k)}
              onChange={() =>
                setSections((v) =>
                  v.includes(k)
                    ? v.filter((x) => x !== k)
                    : SECTION_KEYS.filter((x) => v.includes(x) || x === k),
                )
              }
            >
              {t(`rep.sec.${k}` as MessageKey)}
            </ToggleChip>
          ))}
          {teamOf && (
            <ToggleChip disabled={csv} checked={!csv && perPerson} onChange={setPerPerson}>
              {t('exp.perPerson')}
            </ToggleChip>
          )}
        </div>
        <p className="text-xs text-muted">
          {csv ? t('exp.csvOnly') : isTeam ? t('exp.privacy') : t('exp.privacyMine')}
        </p>
      </div>
    </div>
  );

  const summary = [
    kindName(kind),
    label,
    scopeName,
    csv ? t('exp.format.csv') : t('exp.sectionCount', { n: sections.length }),
    t(`exp.format.${format}`),
  ].join(' · ');

  const preview = (
    <div className="flex min-h-full flex-col gap-3 rounded-control border border-line bg-bg p-4">
      <div className="flex flex-col gap-0.5 border-b-2 border-fg pb-2">
        <span className="text-xs text-muted">{t('exp.preview')}</span>
        <h3 className="text-lg font-bold">{title}</h3>
        <span className="text-xs text-muted">{meta}</span>
      </div>
      {scope === 'me' ? (
        <MinePreview
          key={`${kind}:${period}`}
          kind={kind}
          period={period}
          me={meId}
          tasks={tasks}
          timezone={timezone}
          preset={preset}
          onData={setLoaded}
        />
      ) : (
        <TeamPreview
          key={`${kind}:${period}:${scope}`}
          days={days}
          teams={scope === 'org' ? teams : teamOf ? [teamOf] : []}
          members={members}
          perPerson={Boolean(teamOf)}
          onData={setLoaded}
        />
      )}
      {loaded &&
        (csv ? (
          <CsvPreview header={csvHeader} rows={csvRows} />
        ) : (
          <>
            <SixSections
              data={loaded.data}
              goals={loaded.goals}
              sections={sections}
              team={isTeam}
            />
            {perPerson && loaded.people.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-sm font-bold">{t('exp.perPerson')}</h3>
                {loaded.people.map((p) => (
                  <p key={p.name} className="text-xs">
                    <strong>{p.name}</strong>：
                    {p.time.length
                      ? p.time
                          .map(
                            (r) =>
                              `${projectName(r.project, loaded.goals)} ${t('rep.hours', { h: hours(r.minutes) })}`,
                          )
                          .join('、')
                      : t('report.gen.none')}
                  </p>
                ))}
              </section>
            )}
          </>
        ))}
    </div>
  );

  return (
    <Dialog
      title={t('exp.dialog')}
      width={wide ? 'xl' : 'lg'}
      onClose={onClose}
      footer={
        <DialogFooter
          start={
            needSection ? (
              <span role="alert" className="text-xs text-danger">
                {t('exp.needSection')}
              </span>
            ) : undefined
          }
        >
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!loaded || needSection} onClick={run}>
            {t(`exp.go.${kind}` as MessageKey)}
          </Button>
        </DialogFooter>
      }
    >
      {wide ? (
        <div className="grid h-[calc(90vh-10rem)] min-h-0 grid-cols-[360px_minmax(0,1fr)] gap-5">
          <div className="scroll-panel min-h-0 overflow-y-auto pr-1">{options}</div>
          <div className="scroll-panel min-h-0 overflow-y-auto">{preview}</div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">
              {collapsed ? summary : t('exp.hint')}
            </span>
            <LinkButton className="shrink-0 text-xs" onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? t('exp.expand') : t('exp.collapse')}
            </LinkButton>
          </div>
          {!collapsed && options}
          {preview}
        </>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}

function CsvPreview({ header, rows }: { header: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="text-xs text-muted">{t('rep.noTime')}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <table className="w-full text-left text-xs">
        <thead className="text-muted">
          <tr className="border-b border-line">
            {header.map((h) => (
              <th key={h} className="py-1 pr-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
            <tr key={i} className="border-b border-line">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">{t('exp.csvRows', { n: rows.length })}</p>
    </div>
  );
}

const PreviewSkeleton = () => <Skeleton variant="lines" count={6} label={t('common.loading')} />;

/** 草稿中的報告資料（格式錯誤時略過）。 */
function draftData(draft: string | null): ReportData | null {
  if (!draft) return null;
  try {
    return (JSON.parse(draft) as ReportInput).data ?? null;
  } catch {
    return null;
  }
}

/**
 * 本人範圍：週五收尾帶入的週報 → 已發佈的週報 → 草稿 → 依資料產生（ui-spec v0.45）。
 */
function MinePreview({
  kind,
  period,
  me,
  tasks,
  timezone,
  preset,
  onData,
}: {
  kind: PeriodKind;
  period: string;
  me: string;
  tasks: Task[];
  timezone: string;
  preset: ReportData | null;
  onData: (l: Loaded) => void;
}) {
  const r = useMyReport(kind, period, me, tasks, timezone);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  const worklog = useLoad(() => api.worklogDays(me, monthsOf(periodDays(kind, period))), ['doc']);
  const saved = useLoad(
    () =>
      kind === 'weekly'
        ? api.reportMine('weekly', period)
        : Promise.resolve({ report: null, draft: null }),
    ['doc', 'org'],
  );
  const stored = preset ?? saved.data?.report?.data ?? draftData(saved.data?.draft ?? null);
  const ready =
    Boolean(dirs.data) &&
    Boolean(worklog.data) &&
    Boolean(saved.data) &&
    (Boolean(stored) || r.ready);
  useEffect(() => {
    if (ready)
      onData({
        data: stored ?? r.build(),
        goals: dirs.data?.teamGoals ?? [],
        worklog: worklog.data,
        people: [],
      });
    // 只在資料讀到時產生一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const err = r.error ?? dirs.error ?? worklog.error ?? saved.error;
  if (err) return <ErrorText message={err} />;
  return ready ? null : <PreviewSkeleton />;
}

function TeamPreview({
  days,
  teams,
  members,
  perPerson,
  onData,
}: {
  days: string[];
  teams: TeamView[];
  members: MemberView[];
  perPerson: boolean;
  onData: (l: Loaded) => void;
}) {
  const weeks = weeksOf(days);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  const reports = useLoad(async () => {
    // 同一份週報可能發佈到多個小組，依成員與週去重；各小組、各週同時讀取
    const lists = await Promise.all(
      teams.flatMap((team) =>
        weeks.map((w) => api.reportTeam(team.id, 'weekly', w).catch(() => [])),
      ),
    );
    const out = new Map<string, ReportData>();
    for (const r of lists.flat()) if (r.data) out.set(`${r.member}:${r.period}`, r.data);
    return [...out.values()];
  }, ['doc', 'org']);
  const people = useLoad(async () => {
    if (!perPerson || teams.length !== 1) return [];
    const team = teams[0]!;
    const ids = [...new Set([...team.members, ...team.leads])];
    return Promise.all(
      ids.map(async (id) => {
        const log = await api.worklogDays(id, monthsOf(days)).catch(() => null);
        return {
          name: members.find((m) => m.id === id)?.name ?? '?',
          time: log ? timeRows(log, days) : [],
        };
      }),
    );
  }, ['doc']);
  const ready = Boolean(dirs.data && reports.data && people.data);
  useEffect(() => {
    if (!ready) return;
    const goals = dirs.data?.teamGoals ?? [];
    const data = mergeReports(reports.data ?? []);
    data.summary = summaryOf(data, (p) => projectName(p, goals), summaryText(true));
    onData({ data, goals, worklog: null, people: people.data ?? [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  if (reports.error) return <ErrorText message={reports.error} />;
  if (!ready) return <PreviewSkeleton />;
  return (reports.data ?? []).length === 0 ? (
    <p className="text-xs text-muted">{t('exp.noReports')}</p>
  ) : null;
}
