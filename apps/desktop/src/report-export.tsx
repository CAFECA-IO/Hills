/**
 * 匯出報告（ui-spec「工作 › 報告與匯出」A7，D61；technical-design §16.13 v0.34）：
 * 日 / 週 / 月 / 季 / 年 × 我自己 / 小組（負責人）/ 全公司（管理者）× PDF / Markdown / CSV。
 * 小組與全公司只用已發佈的週報（專案層級）；「每人一節」只給負責人的小組範圍（D62）。
 */
import { useEffect, useState } from 'react';
import {
  api,
  type DayLog,
  type MemberView,
  type ReportData,
  type Task,
  type TeamGoal,
  type TeamView,
} from './api';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
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
  toCsv,
  weeksOf,
  worklogCsv,
  type PeriodKind,
  type SectionKey,
} from './report-utils';
import { mdText, projectName, SixSections, summaryText } from './report-view';
import {
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  ErrorText,
  IconButton,
  Radio,
  SegmentedControl,
  useAction,
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

export function ExportDialog({
  initialKind,
  initialScope = 'me',
  members,
  teams,
  tasks,
  timezone,
  onClose,
}: {
  initialKind: PeriodKind;
  /** `me` 或小組 id 或 `org` */
  initialScope?: string;
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  timezone: string;
  onClose: () => void;
}) {
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const [kind, setKind] = useState<PeriodKind>(initialKind);
  const [shift, setShift] = useState(0);
  const period = shiftKindPeriod(kind, periodOfDay(kind, today), shift);
  const leadOf = teams.filter((x) => x.leads.includes(meId));
  const [scope, setScope] = useState(initialScope);
  const [sections, setSections] = useState<SectionKey[]>(SECTION_KEYS);
  const [perPerson, setPerPerson] = useState(false);
  const [format, setFormat] = useState<Format>('pdf');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { busy, error, attempt } = useAction();
  const days = periodDays(kind, period);
  const ongoing = days.includes(today) || days[days.length - 1]! > today;
  const teamOf = teams.find((x) => x.id === scope) ?? null;
  const scopeName =
    scope === 'me' ? (me?.name ?? '') : scope === 'org' ? t('exp.scope.org') : (teamOf?.name ?? '');
  const title = t(`exp.title.${kind}` as MessageKey, { name: scopeName, period });
  const meta = [
    `${days[0]} – ${days[days.length - 1]}`,
    ongoing ? t('exp.asOf', { day: today }) : '',
    t('exp.by', { name: me?.name ?? '' }),
  ]
    .filter(Boolean)
    .join(' · ');

  const run = () =>
    void attempt(async () => {
      if (!loaded) return;
      const md = () => {
        const extra =
          perPerson && loaded.people.length
            ? [
                `## ${t('exp.perPerson')}`,
                '',
                ...loaded.people.flatMap((p) => [
                  `### ${p.name}`,
                  '',
                  ...(p.time.length
                    ? p.time.map(
                        (r) =>
                          `- ${projectName(r.project, loaded.goals)}：${hours(r.minutes)} ${t('rep.hoursUnit')}`,
                      )
                    : [`- ${t('report.gen.none')}`]),
                  '',
                ]),
              ]
            : [];
        return reportMarkdown(title, meta, loaded.data, sections, mdText(loaded.goals), extra);
      };
      if (format === 'pdf') {
        printMarkdown(md());
        return;
      }
      if (format === 'md') {
        await api.exportText(`${title}.md`, md());
        return;
      }
      const csv = loaded.worklog
        ? worklogCsv(
            loaded.worklog,
            days,
            [
              t('exp.csv.date'),
              t('exp.csv.item'),
              t('exp.csv.project'),
              t('exp.csv.minutes'),
              t('exp.csv.source'),
            ],
            (p) => projectName(p, loaded.goals),
            () => t('time.meeting'),
          )
        : toCsv([
            [t('exp.csv.project'), t('exp.csv.minutes'), t('exp.csv.share')],
            ...loaded.data.time.map((r) => {
              const total = loaded.data.time.reduce((n, x) => n + x.minutes, 0);
              return [
                projectName(r.project, loaded.goals),
                r.minutes,
                `${total ? Math.round((r.minutes / total) * 100) : 0}%`,
              ];
            }),
          ]);
      await api.exportText(`${title}.csv`, csv);
    });

  return (
    <Dialog
      title={t('exp.dialog')}
      width="lg"
      onClose={onClose}
      footer={
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!loaded} onClick={run}>
            {t(`exp.go.${kind}` as MessageKey)}
          </Button>
        </DialogFooter>
      }
    >
      <p className="text-xs text-muted">{t('exp.hint')}</p>
      <div className="flex flex-col gap-2">
        <SegmentedControl
          label={t('exp.kind')}
          options={PERIOD_KINDS.map((k) => ({ value: k, label: t(`exp.kind.${k}` as MessageKey) }))}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setShift(0);
            setLoaded(null);
          }}
        />
        <div className="flex items-center gap-2 text-sm">
          <IconButton
            size="sm"
            variant="secondary"
            label={t('report.prev')}
            onClick={() => {
              setShift((s) => s - 1);
              setLoaded(null);
            }}
          >
            ‹
          </IconButton>
          <strong>
            {days[0]} – {days[days.length - 1]}
          </strong>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('report.next')}
            disabled={shift >= 0}
            onClick={() => {
              setShift((s) => Math.min(0, s + 1));
              setLoaded(null);
            }}
          >
            ›
          </IconButton>
          {ongoing && <span className="text-xs text-muted">{t('exp.asOf', { day: today })}</span>}
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
        <legend className="mb-1 text-xs font-bold text-muted">{t('exp.scope')}</legend>
        <Radio
          name="exp-scope"
          label={t('exp.scope.me')}
          checked={scope === 'me'}
          onChange={() => {
            setScope('me');
            setLoaded(null);
          }}
        />
        {leadOf.map((x) => (
          <Radio
            key={x.id}
            name="exp-scope"
            label={t('exp.scope.team', {
              name: x.name,
              n: new Set([...x.members, ...x.leads]).size,
            })}
            checked={scope === x.id}
            onChange={() => {
              setScope(x.id);
              setLoaded(null);
            }}
          />
        ))}
        <Radio
          name="exp-scope"
          label={t('exp.scope.org')}
          disabled={!me?.isAdmin}
          checked={scope === 'org'}
          onChange={() => {
            setScope('org');
            setLoaded(null);
          }}
        />
      </fieldset>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
        <legend className="mb-1 text-xs font-bold text-muted">{t('exp.content')}</legend>
        {SECTION_KEYS.map((k) => (
          <Checkbox
            key={k}
            label={t(`rep.sec.${k}` as MessageKey)}
            checked={sections.includes(k)}
            onChange={() =>
              setSections((v) =>
                v.includes(k)
                  ? v.filter((x) => x !== k)
                  : SECTION_KEYS.filter((x) => v.includes(x) || x === k),
              )
            }
          />
        ))}
        {teamOf && (
          <Checkbox
            label={t('exp.perPerson')}
            checked={perPerson}
            onChange={() => setPerPerson((x) => !x)}
          />
        )}
      </fieldset>
      <p className="text-xs text-muted">{t('exp.privacy')}</p>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
        <legend className="mb-1 text-xs font-bold text-muted">{t('exp.format')}</legend>
        {(['pdf', 'md', 'csv'] as const).map((f) => (
          <Radio
            key={f}
            name="exp-format"
            label={t(`exp.format.${f}`)}
            checked={format === f}
            onChange={() => setFormat(f)}
          />
        ))}
      </fieldset>
      <div className="flex flex-col gap-3 rounded-control border border-line bg-bg p-4">
        <div className="flex flex-col gap-0.5 border-b-2 border-fg pb-2">
          <span className="text-xs text-muted">{t('exp.preview')}</span>
          <h2 className="text-lg font-bold">{title}</h2>
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
        {loaded && (
          <>
            <SixSections data={loaded.data} goals={loaded.goals} sections={sections} />
            {perPerson && loaded.people.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-sm font-bold">{t('exp.perPerson')}</h3>
                {loaded.people.map((p) => (
                  <p key={p.name} className="text-xs">
                    <strong>{p.name}</strong>：
                    {p.time.length
                      ? p.time
                          .map(
                            (r) => `${projectName(r.project, loaded.goals)} ${hours(r.minutes)}h`,
                          )
                          .join('、')
                      : t('report.gen.none')}
                  </p>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <ErrorText message={error} />
    </Dialog>
  );
}

function MinePreview({
  kind,
  period,
  me,
  tasks,
  timezone,
  onData,
}: {
  kind: PeriodKind;
  period: string;
  me: string;
  tasks: Task[];
  timezone: string;
  onData: (l: Loaded) => void;
}) {
  const r = useMyReport(kind, period, me, tasks, timezone);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  const worklog = useLoad(() => api.worklogDays(me, monthsOf(periodDays(kind, period))), ['doc']);
  const ready = r.ready && Boolean(dirs.data) && Boolean(worklog.data);
  useEffect(() => {
    if (ready)
      onData({
        data: r.build(),
        goals: dirs.data?.teamGoals ?? [],
        worklog: worklog.data,
        people: [],
      });
    // 只在資料讀到時產生一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  if (r.error) return <ErrorText message={r.error} />;
  return ready ? null : <p className="text-xs text-muted">{t('common.loading')}</p>;
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
    // 同一份週報可能發佈到多個小組，依成員與週去重
    const out = new Map<string, ReportData>();
    for (const team of teams) {
      for (const w of weeks) {
        const list = await api.reportTeam(team.id, 'weekly', w).catch(() => []);
        for (const r of list) if (r.data) out.set(`${r.member}:${r.period}`, r.data);
      }
    }
    return [...out.values()];
  }, ['doc', 'org']);
  const people = useLoad(async () => {
    if (!perPerson || teams.length !== 1) return [];
    const team = teams[0]!;
    const ids = [...new Set([...team.members, ...team.leads])];
    const out: Loaded['people'] = [];
    for (const id of ids) {
      const log = await api.worklogDays(id, monthsOf(days)).catch(() => null);
      out.push({
        name: members.find((m) => m.id === id)?.name ?? '?',
        time: log ? timeRows(log, days) : [],
      });
    }
    return out;
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
  if (!ready) return <p className="text-xs text-muted">{t('common.loading')}</p>;
  return (reports.data ?? []).length === 0 ? (
    <p className="text-xs text-muted">{t('exp.noReports')}</p>
  ) : null;
}
