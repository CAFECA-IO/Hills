/**
 * 報告六段的畫面（ui-spec「工作 › 報告與匯出」R1，D61）：週五收尾與匯出預覽共用。
 */
import type { Reason, ReasonKind, ReportData, TeamGoal } from './api';
import { t, type MessageKey } from './i18n';
import {
  deviationOf,
  hours,
  NONTASK,
  OTHER,
  periodParts,
  type MdText,
  type PeriodKind,
  type ReasonText,
  type SectionKey,
  type SummaryText,
} from './report-utils';
import { Badge, IconButton, LinkButton, Select, TextArea, TextInput } from './ui';

/** 專案色（類別色，一律搭配圖例文字）。 */
const SWATCH = [
  'bg-level-quarter',
  'bg-level-year',
  'bg-level-month',
  'bg-level-week',
  'bg-primary',
];

export function projectName(p: string, goals: TeamGoal[]): string {
  if (p === OTHER) return t('rep.other');
  if (p === NONTASK) return t('rep.nontask');
  return goals.find((g) => g.id === p)?.title ?? t('rep.unknownProject');
}

export function reasonName(k: ReasonKind): string {
  return t(`rep.reason.${k}` as MessageKey);
}

export const reasonText = (): ReasonText => ({
  blocked: (title, text) => t('rep.r.blocked', { title, text }),
  underestimate: (title, est, actual) => t('rep.r.underestimate', { title, est, actual }),
  unplanned: (title) => t('rep.r.unplanned', { title }),
  reopened: (title, text) => t('rep.r.reopened', { title, text }),
});

export const summaryText = (team = false): SummaryText => ({
  empty: t('rep.s.empty'),
  top: (title, h, share, mine) =>
    // 小組範圍或沒推進時不寫「我推進了 0 個百分點」
    team || Number(mine) === 0
      ? t('rep.s.topTeam', { title, h, share })
      : t('rep.s.top', { title, h, share, mine }),
  rest: (other, unplanned, nontask) => t('rep.s.rest', { other, unplanned, nontask }),
  tasks: (done, planned) => t('rep.s.tasks', { done, planned }),
  deviation: (pct) => t('rep.s.deviation', { pct }),
  because: (reasons) => t('rep.s.because', { reasons }),
  end: t('rep.s.end'),
  reasonName,
});

/** 期間的顯示寫法（ui-spec v0.45）：日「11/14（六）」、週「11/09 – 11/15 · W46」、月「2026 年 11 月」…。 */
export function periodLabel(kind: PeriodKind, period: string): string {
  const p = periodParts(kind, period);
  const md = ([m, d]: [number, number]) =>
    `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
  switch (kind) {
    case 'daily':
      return t('period.day', {
        md: md(p.start),
        wd: t(`scrum.weekday.${p.weekday}` as MessageKey),
      });
    case 'weekly':
      return t('period.week', { a: md(p.start), b: md(p.end), w: p.n });
    case 'monthly':
      return t('period.month', { y: p.y, m: p.n });
    case 'quarterly':
      return t('period.quarter', { y: p.y, q: p.n });
    case 'yearly':
      return String(p.y);
  }
}

export const mdText = (goals: TeamGoal[]): MdText => ({
  section: (k) => t(`rep.sec.${k}` as MessageKey),
  next: t('rep.next'),
  project: (p) => projectName(p, goals),
  reasonName,
  hoursUnit: t('rep.hoursUnit'),
  deviation: (pct) => t('rep.deviation', { pct }),
  tasks: (done, planned, carried) => t('rep.tasksLine', { done, planned, carried }),
  none: t('report.gen.none'),
});

const swatchOf = (p: string, i: number) =>
  p === OTHER ? 'bg-muted' : p === NONTASK ? 'bg-line' : SWATCH[i % SWATCH.length]!;

export function SixSections({
  data,
  goals,
  sections,
  onChange,
  team = false,
}: {
  data: ReportData;
  goals: TeamGoal[];
  sections?: SectionKey[];
  /** 小組 / 全公司範圍（欄名改為成員推進合計） */
  team?: boolean;
  /** 有值時可編輯（摘要、原因、做了什麼與下期） */
  onChange?: (d: ReportData) => void;
}) {
  const show = (k: SectionKey) => !sections || sections.includes(k);
  const total = data.time.reduce((n, r) => n + r.minutes, 0);
  const dev = deviationOf(data.plan);
  const maxPlan = Math.max(1, ...data.plan.minutes.flatMap((r) => [r.planned, r.actual]));
  const set = (p: Partial<ReportData>) => onChange?.({ ...data, ...p });
  const projectIndex = (p: string) =>
    data.time
      .filter((r) => r.project !== OTHER && r.project !== NONTASK)
      .findIndex((r) => r.project === p);
  return (
    <div className="flex flex-col gap-4">
      {show('summary') && (
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            {t('rep.sec.summary')}
            <Badge>{data.summaryEdited ? t('rep.edited') : t('rep.generated')}</Badge>
          </h3>
          {onChange ? (
            <TextArea
              rows={3}
              aria-label={t('rep.sec.summary')}
              value={data.summary}
              onChange={(e) => set({ summary: e.target.value, summaryEdited: true })}
            />
          ) : (
            <p className="text-sm leading-relaxed">{data.summary || t('report.gen.none')}</p>
          )}
        </section>
      )}

      {show('time') && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">
            {t('rep.sec.time')}
            <span className="ml-2 text-xs font-normal text-muted">
              {t('rep.total', { h: hours(total) })}
            </span>
          </h3>
          {total === 0 ? (
            <p className="text-xs text-muted">{t('rep.noTime')}</p>
          ) : (
            <>
              <div className="flex h-4 w-full overflow-hidden rounded-full" aria-hidden>
                {data.time.map((r) => (
                  <span
                    key={r.project}
                    className={swatchOf(r.project, projectIndex(r.project))}
                    style={{ width: `${(r.minutes / total) * 100}%` }}
                  />
                ))}
              </div>
              <ul className="flex flex-col gap-1 text-xs">
                {data.time.map((r) => (
                  <li key={r.project} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`size-2.5 shrink-0 rounded-sm ${swatchOf(r.project, projectIndex(r.project))}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{projectName(r.project, goals)}</span>
                    <span>{t('rep.hours', { h: hours(r.minutes) })}</span>
                    <span className="w-10 text-right text-muted">
                      {Math.round((r.minutes / total) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {show('projects') && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{t('rep.sec.projects')}</h3>
          {data.projects.length === 0 ? (
            <p className="text-xs text-muted">{t('rep.noProjects')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-1 pr-2 font-semibold">{t('rep.col.project')}</th>
                  <th className="py-1 pr-2 font-semibold">
                    {t(team ? 'rep.col.teamTime' : 'rep.col.myTime')}
                  </th>
                  <th className="py-1 pr-2 font-semibold">{t('rep.col.progress')}</th>
                  <th className="py-1 font-semibold">
                    {t(team ? 'rep.col.teamMine' : 'rep.col.mine')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.project} className="border-b border-line">
                    <td className="py-1.5 pr-2 font-semibold">{projectName(p.project, goals)}</td>
                    <td className="py-1.5 pr-2">
                      {t('rep.hours', {
                        h: hours(data.time.find((r) => r.project === p.project)?.minutes ?? 0),
                      })}
                    </td>
                    <td className="py-1.5 pr-2">
                      {p.start === null ? '—' : `${Math.round(p.start)}%`} → {Math.round(p.end)}%
                    </td>
                    <td className="py-1.5">
                      {p.mine >= 0 ? '+' : ''}
                      {p.mine}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {show('plan') && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold">{t('rep.sec.plan')}</h3>
          {data.plan.minutes.length === 0 ? (
            <p className="text-xs text-muted">{t('rep.noPlan')}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-xs">
              {data.plan.minutes.map((r) => {
                const diff = r.actual - r.planned;
                return (
                  <li key={r.project} className="flex flex-col gap-0.5">
                    <span className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {projectName(r.project, goals)}
                      </span>
                      <span>
                        {t('rep.planLine', {
                          planned: hours(r.planned),
                          actual: hours(r.actual),
                          diff: `${diff >= 0 ? '+' : '−'}${hours(Math.abs(diff))}`,
                        })}
                      </span>
                    </span>
                    <span className="flex flex-col gap-0.5" aria-hidden>
                      <span
                        className="h-1.5 rounded-full bg-line"
                        style={{ width: `${(r.planned / maxPlan) * 100}%` }}
                      />
                      <span
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${(r.actual / maxPlan) * 100}%` }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs">
            {dev !== null && (
              <span className="mr-3 font-semibold">{t('rep.deviation', { pct: dev })}</span>
            )}
            {t('rep.tasksLine', {
              done: data.plan.tasks.done,
              planned: data.plan.tasks.planned,
              carried: data.plan.tasks.carried,
            })}
          </p>
          <p className="text-xs text-muted">{t('rep.planLegend')}</p>
        </section>
      )}

      {show('reasons') && (
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            {t('rep.sec.reasons')}
            <Badge>{t('rep.autoFound')}</Badge>
          </h3>
          {data.reasons.length === 0 && <p className="text-xs text-muted">{t('rep.noReasons')}</p>}
          <ul className="flex flex-col gap-1.5 text-sm">
            {data.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                {onChange ? (
                  <ReasonEdit
                    r={r}
                    onChange={(x) =>
                      set({ reasons: data.reasons.map((y, k) => (k === i ? x : y)) })
                    }
                  />
                ) : (
                  <span className="min-w-0 flex-1">
                    <strong>{reasonName(r.kind)}</strong>：{r.text}
                    {r.minutes ? (
                      <span className="text-xs text-muted">
                        {' '}
                        · {t('rep.hours', { h: hours(r.minutes) })}
                      </span>
                    ) : null}
                  </span>
                )}
                {onChange && (
                  <IconButton
                    size="sm"
                    label={t('rep.removeReason')}
                    onClick={() => set({ reasons: data.reasons.filter((_, k) => k !== i) })}
                  >
                    ×
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          {onChange && (
            <LinkButton
              className="self-start text-sm"
              onClick={() =>
                set({ reasons: [...data.reasons, { kind: 'other', text: '', minutes: null }] })
              }
            >
              {t('rep.addReason')}
            </LinkButton>
          )}
        </section>
      )}

      {show('done') && (
        <section className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-bold">{t('rep.sec.done')}</h3>
            {onChange ? (
              <TextArea
                rows={6}
                className="font-mono text-xs"
                aria-label={t('rep.sec.done')}
                value={data.doneMd}
                onChange={(e) => set({ doneMd: e.target.value })}
              />
            ) : (
              <pre className="font-sans text-xs whitespace-pre-wrap">
                {data.doneMd || t('report.gen.none')}
              </pre>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-bold">{t('rep.next')}</h3>
            {onChange ? (
              <TextArea
                rows={6}
                className="font-mono text-xs"
                aria-label={t('rep.next')}
                value={data.nextMd}
                onChange={(e) => set({ nextMd: e.target.value })}
              />
            ) : (
              <pre className="font-sans text-xs whitespace-pre-wrap">
                {data.nextMd || t('report.gen.none')}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

const KINDS: ReasonKind[] = ['blocked', 'underestimate', 'unplanned', 'reopened', 'leave', 'other'];

function ReasonEdit({ r, onChange }: { r: Reason; onChange: (r: Reason) => void }) {
  return (
    <span className="flex min-w-0 flex-1 gap-2">
      <Select
        size="sm"
        className="w-auto"
        aria-label={t('rep.reasonKind')}
        value={r.kind}
        onChange={(e) => onChange({ ...r, kind: e.target.value as ReasonKind })}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {reasonName(k)}
          </option>
        ))}
      </Select>
      <TextInput
        className="min-w-0 flex-1"
        maxLength={500}
        aria-label={t('rep.reasonText')}
        value={r.text}
        onChange={(e) => onChange({ ...r, text: e.target.value })}
      />
    </span>
  );
}
