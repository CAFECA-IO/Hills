/**
 * 目標 → 團隊（ui-spec「目標 → 團隊」v0.20，D47；設計畫布 D1、D2、D3、D7）：
 * 團隊往哪裡走、每個人往哪裡走（清單 / 方向羅盤）、某人的方向與四項檢查、建議對齊。
 */
import { BreakdownDialog } from './assign-breakdown';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type Direction,
  type DirectionRules,
  type DirectionWeek,
  type MemberDirection,
  type MemberView,
  type TeamGoal,
  type TeamView,
  type WeekNote,
} from './api';
import { DirectionCompass, type CompassPerson } from './compass';
import {
  assess,
  meanAngle,
  quarterElapsed,
  trailOf,
  trendOf,
  sideOf,
  stateRank,
  summariesByMember,
  type Assessment,
} from './drift-utils';
import type { Periods } from './goals-utils';
import { t } from './i18n';
import { lookOf } from './summit';
import {
  Button,
  Card,
  ConfirmButton,
  Dialog,
  Field,
  Switch,
  TextInput,
  EmptyState,
  ErrorText,
  LinkButton,
  ListButton,
  ProgressBar,
  SegmentedControl,
  useAction,
} from './ui';

export interface TeamTabProps {
  directions: Direction[];
  teamGoals: TeamGoal[];
  teams: TeamView[];
  members: MemberView[];
  summaries: MemberDirection[];
  rules: DirectionRules;
  me: string;
  isAdmin: boolean;
  periods: Periods;
  now: number;
  weekNotes: WeekNote[];
  onEditGoal: (team: string, goal: TeamGoal | null) => void;
  onChanged: () => void;
  /** 組織時區（「拆成任務」計算負荷用，D50） */
  timezone?: string;
}

type View =
  | { kind: 'overview' }
  | { kind: 'team'; team: string }
  | { kind: 'person'; team: string; member: string };

interface Row {
  member: MemberView;
  a: Assessment;
}

const teamIds = (tm: TeamView) => [...new Set([...tm.members, ...tm.leads])];

/** 狀態膠囊：形狀 + 文字 + 顏色。 */
export function StatePill({
  state,
  children,
}: {
  state: Assessment['state'];
  children?: ReactNode;
}) {
  const style = {
    ok: 'bg-primary-soft text-primary',
    warn: 'border border-warning text-warning',
    stale: 'border border-line text-muted',
    unknown: 'border border-line text-muted',
  }[state];
  const mark = { ok: '●', warn: '▲', stale: '◷', unknown: '○' }[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${style}`}
    >
      <span aria-hidden="true">{mark}</span>
      {children ?? t(`drift.state.${state}`)}
    </span>
  );
}

function reasonKeys(a: Assessment): ('unaligned' | 'elsewhere' | 'behind' | 'stale')[] {
  const out: ('unaligned' | 'elsewhere' | 'behind' | 'stale')[] = [];
  if (a.unaligned) out.push('unaligned');
  if (a.elsewhere) out.push('elsewhere');
  if (a.behind) out.push('behind');
  if (a.stale && a.week) out.push('stale');
  return out;
}

function Reasons({ a }: { a: Assessment }) {
  return (
    <>
      {reasonKeys(a)
        .filter((k) => !(k === 'stale' && a.state === 'stale'))
        .map((k) => (
          <span
            key={k}
            className="rounded-md border border-warning px-2 py-0.5 text-xs text-warning"
          >
            {t(`drift.reason.${k}`)}
          </span>
        ))}
    </>
  );
}

/** 滑過人像時的摘要（D7）。 */
function PersonTip({
  name,
  a,
  today,
  trend,
}: {
  name: string;
  a: Assessment;
  today: number;
  trend: ReturnType<typeof trendOf>;
}) {
  const w = a.week;
  const goal = w?.goals[0];
  return (
    <>
      <span className="flex items-center gap-2">
        <strong className="text-sm">{name}</strong>
        <StatePill state={a.state} />
      </span>
      <TipRow k={t('drift.tip.time')} bad={a.elsewhere}>
        {a.share === null
          ? t('drift.tip.noUnits')
          : t('drift.tip.share', { pct: Math.round(a.share), deg: Math.round(a.angle) })}
      </TipRow>
      <TipRow k={t('drift.tip.progress')} bad={a.behind}>
        {a.progress === null
          ? '—'
          : t('drift.tip.progressValue', { pct: Math.round(a.progress), today: Math.round(today) })}
      </TipRow>
      <TipRow k={t('drift.tip.goal')} bad={a.unaligned}>
        {goal
          ? `${goal.title}${goal.alignedGoalId ? '' : t('drift.tip.unaligned')}`
          : t('drift.tip.noGoal')}
      </TipRow>
      <TipRow k={t('drift.tip.updated')} bad={a.stale}>
        {a.idleDays === null
          ? '—'
          : a.idleDays === 0
            ? t('drift.today')
            : t('drift.daysAgo', { n: a.idleDays })}
      </TipRow>
      {trend && (
        <span className="text-muted">
          {t(`drift.trend.${trend.kind}`, { path: trend.path.map((d) => `${d}°`).join(' → ') })}
        </span>
      )}
      <span className="border-t border-line pt-1.5 text-muted">{t(`drift.advice.${a.state}`)}</span>
    </>
  );
}

function TipRow({ k, bad, children }: { k: string; bad: boolean; children: ReactNode }) {
  return (
    <span className="grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-2">
      <span className="text-muted">{k}</span>
      <span className={bad ? 'font-bold text-warning' : ''}>{children}</span>
    </span>
  );
}

export function TeamTab(props: TeamTabProps) {
  const { teams, members, summaries, rules, periods, now, teamGoals } = props;
  const [view, setView] = useState<View>({ kind: 'overview' });
  const byMember = useMemo(() => summariesByMember(summaries), [summaries]);
  const today = quarterElapsed(periods) * 100;
  const rowsOf = (tm: TeamView): Row[] =>
    teamIds(tm)
      .map((id) => members.find((m) => m.id === id))
      .filter((m): m is MemberView => Boolean(m))
      .map((member) => ({ member, a: assess(byMember.get(member.id), rules, periods, now) }))
      .sort(
        (x, y) =>
          stateRank(x.a.state) - stateRank(y.a.state) || x.member.name.localeCompare(y.member.name),
      );
  const goalOf = (team: string) =>
    teamGoals.find((g) => g.team === team && g.year === periods.year) ?? null;
  const person = (r: Row, isMe: boolean): CompassPerson => {
    const trail = trailOf(byMember.get(r.member.id));
    const trend = r.a.share === null ? null : trendOf(trail, r.a.angle);
    return {
      id: r.member.id,
      name: r.member.name,
      look: lookOf(r.member),
      angle: r.a.angle,
      progress: r.a.progress,
      state: r.a.state === 'unknown' ? 'stale' : r.a.state,
      unaligned: r.a.unaligned,
      isMe,
      side: sideOf(r.member.id),
      trail,
      tip: (
        <PersonTip
          name={isMe ? t('drift.you') : r.member.name}
          a={r.a}
          today={today}
          trend={trend}
        />
      ),
    };
  };
  if (view.kind === 'team' || view.kind === 'person') {
    const tm = teams.find((x) => x.id === view.team);
    if (tm) {
      const rows = rowsOf(tm);
      if (view.kind === 'person') {
        const r = rows.find((x) => x.member.id === view.member);
        if (r) {
          return (
            <PersonView
              {...props}
              team={tm}
              row={r}
              goal={goalOf(tm.id)}
              weeks={byMember.get(r.member.id) ?? []}
              today={today}
              onBack={() => setView({ kind: 'team', team: tm.id })}
            />
          );
        }
      }
      return (
        <TeamView
          {...props}
          team={tm}
          rows={rows}
          goal={goalOf(tm.id)}
          today={today}
          person={person}
          onBack={() => setView({ kind: 'overview' })}
          onOpen={(member) => setView({ kind: 'person', team: tm.id, member })}
        />
      );
    }
  }
  return (
    <Overview
      {...props}
      rowsOf={rowsOf}
      today={today}
      person={person}
      onOpenTeam={(team) => setView({ kind: 'team', team })}
    />
  );
}

// ── D1 團隊往哪裡走 ─────────────────────────────────────────

function Overview({
  directions,
  teamGoals,
  teams,
  me,
  isAdmin,
  periods,
  rowsOf,
  today,
  person,
  onEditGoal,
  onChanged,
  onOpenTeam,
  members,
  timezone,
}: TeamTabProps & {
  rowsOf: (tm: TeamView) => Row[];
  today: number;
  person: (r: Row, isMe: boolean) => CompassPerson;
  onOpenTeam: (team: string) => void;
}) {
  const years = [periods.year, String(Number(periods.year) + 1)];
  const [y, setY] = useState(periods.year);
  const dirs = directions.filter((d) => d.year === y);
  const { error, attempt } = useAction();
  const [breaking, setBreaking] = useState<{ team: TeamView; goal: string } | null>(null);
  const all = teams.flatMap((tm) => rowsOf(tm));
  const unique = [...new Map(all.map((r) => [r.member.id, r])).values()];
  const myTeam = teams.find((tm) => teamIds(tm).includes(me));
  const myRow = unique.find((r) => r.member.id === me);
  const count = (k: 'unaligned' | 'elsewhere' | 'behind' | 'stale') =>
    unique.filter((r) => reasonKeys(r.a).includes(k));
  const onTrack = unique.filter((r) => r.a.state === 'ok').length;
  const current = y === periods.year;
  return (
    <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-3">
          <SegmentedControl
            label={t('guide.team.year')}
            options={years.map((v) => ({ value: v, label: v }))}
            value={y}
            onChange={setY}
          />
          <span className="text-xs text-muted">
            {current
              ? t('drift.quarterElapsed', {
                  quarter: periods.quarter.slice(5),
                  pct: Math.round(today),
                })
              : t('guide.team.hint')}
          </span>
        </div>
        {dirs.length === 0 ? (
          <Card>
            <EmptyState>
              {isAdmin ? t('guide.team.noDirectionAdmin') : t('guide.team.noDirection')}
            </EmptyState>
          </Card>
        ) : (
          <div className="flex gap-3.5">
            {dirs.map((d, i) => {
              const n = teamGoals.filter((g) => g.directionId === d.id).length;
              return (
                <Card key={d.id} padding="sm" className="flex min-w-0 flex-1 flex-col gap-2">
                  <span className="text-xs font-bold text-level-year">
                    {t('guide.team.direction', { n: i + 1 })}
                  </span>
                  <span className="text-base font-bold">{d.title}</span>
                  <div className="flex items-center gap-2.5">
                    <ProgressBar
                      value={d.progress / 100}
                      size="sm"
                      className="flex-1"
                      barClassName="bg-level-year"
                      label={d.title}
                    />
                    <span className="w-9 text-right text-sm font-bold">
                      {Math.round(d.progress)}%
                    </span>
                  </div>
                  <span className="text-xs text-muted">{t('guide.team.pushing', { n })}</span>
                </Card>
              );
            })}
          </div>
        )}
        <Card padding="none" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-baseline gap-2.5 px-5 pt-4 pb-2">
            <h2 className="text-base font-bold">{t('guide.team.teams')}</h2>
            <span className="text-xs text-muted">{t('drift.teams.hint')}</span>
          </div>
          <div className="scroll-panel min-h-0 flex-1">
            {teams.map((tm) => {
              const goals = teamGoals.filter((g) => g.team === tm.id && g.year === y);
              const canEdit = isAdmin || tm.leads.includes(me);
              const rows = rowsOf(tm);
              const warn = rows.filter((r) => r.a.state === 'warn').length;
              const stale = rows.filter((r) => r.a.state === 'stale').length;
              const ok = rows.filter((r) => r.a.state === 'ok').length;
              return (
                <div
                  key={tm.id}
                  className="grid grid-cols-[110px_minmax(0,1fr)_110px_auto] items-center gap-4 border-t border-line px-5 py-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <LinkButton
                      className="self-start text-left font-bold"
                      onClick={() => onOpenTeam(tm.id)}
                    >
                      {tm.name}
                    </LinkButton>
                    <span className="text-xs text-muted">
                      {t('guide.team.people', { n: rows.length })}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    {goals.length === 0 && (
                      <span className="text-muted">{t('guide.team.noGoal')}</span>
                    )}
                    {goals.map((g) => {
                      const d = directions.find((x) => x.id === g.directionId);
                      return (
                        <div key={g.id} className="flex items-center gap-3">
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate text-base font-semibold">{g.title}</span>
                            <span className="truncate text-xs text-muted">
                              {d
                                ? t('guide.forTitle', { title: d.title })
                                : t('guide.team.unaligned')}
                            </span>
                          </div>
                          <ProgressBar
                            value={g.progress / 100}
                            size="sm"
                            className="w-24"
                            label={g.title}
                          />
                          <span className="w-9 text-right text-sm font-bold">
                            {Math.round(g.progress)}%
                          </span>
                          {canEdit && (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setBreaking({ team: tm, goal: g.id })}
                              >
                                {t('breakdown.fromGoal')}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onEditGoal(tm.id, g)}
                              >
                                {t('guide.team.edit')}
                              </Button>
                              <ConfirmButton
                                label={t('guide.team.delete')}
                                message={t('guide.team.deleteConfirm', { title: g.title })}
                                onConfirm={() =>
                                  void attempt(() => api.deleteTeamGoal(tm.id, g.id)).then(
                                    onChanged,
                                  )
                                }
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                    {canEdit && (
                      <Button
                        variant="soft"
                        size="sm"
                        className="self-start"
                        onClick={() => onEditGoal(tm.id, null)}
                      >
                        {t('guide.team.setGoal')}
                      </Button>
                    )}
                  </div>
                  {current ? (
                    <DirectionCompass
                      mode="mini"
                      width={110}
                      height={52}
                      radius={40}
                      today={today}
                      people={rows.map((r) => person(r, r.member.id === me))}
                      label={t('drift.compass.label', { team: tm.name })}
                    />
                  ) : (
                    <span />
                  )}
                  <div className="flex flex-col items-start gap-1">
                    {current && (
                      <>
                        <StatePill state="ok">{t('drift.count.ok', { n: ok })}</StatePill>
                        {warn > 0 && (
                          <StatePill state="warn">{t('drift.count.warn', { n: warn })}</StatePill>
                        )}
                        {stale > 0 && (
                          <StatePill state="stale">
                            {t('drift.count.stale', { n: stale })}
                          </StatePill>
                        )}
                        <LinkButton className="text-xs" onClick={() => onOpenTeam(tm.id)}>
                          {t('drift.openTeam')}
                        </LinkButton>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <ErrorText message={error} />
          <p className="border-t border-line px-5 py-3 text-xs text-muted">{t('drift.footer')}</p>
        </Card>
      </section>
      <Card className="flex w-70 shrink-0 flex-col gap-2 wide:w-85">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold">{t('drift.mine.title')}</h2>
          {myRow && <StatePill state={myRow.a.state} />}
        </div>
        {myRow && myTeam ? (
          <>
            <div className="flex justify-center">
              <DirectionCompass
                mode="me"
                width={260}
                height={190}
                radius={110}
                today={today}
                teamLabel={myTeam.name}
                people={[person(myRow, true)]}
                label={t('drift.compass.mine')}
              />
            </div>
            <MySentence a={myRow.a} today={today} />
          </>
        ) : (
          <EmptyState>{t('drift.mine.empty')}</EmptyState>
        )}
        <div className="mt-2 flex items-baseline gap-1.5 border-t border-line pt-3">
          <span className="text-sm font-bold">{t('drift.company')}</span>
          <span className="ml-auto text-xl font-bold">{onTrack}</span>
          <span className="text-sm text-muted">{t('drift.company.of', { n: unique.length })}</span>
        </div>
        {(['unaligned', 'elsewhere', 'behind', 'stale'] as const).map((k) => {
          const list = count(k);
          return (
            <div key={k} className="flex items-center gap-2.5 border-t border-line py-1.5 text-sm">
              <span className="rounded-md border border-warning px-2 py-0.5 text-xs text-warning">
                {t(`drift.reason.${k}`)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {list.map((r) => r.member.name).join('、')}
              </span>
              <strong>{list.length}</strong>
            </div>
          );
        })}
      </Card>
      {breaking && (
        <BreakdownDialog
          team={breaking.team}
          teamGoals={teamGoals}
          goalId={breaking.goal}
          members={members}
          timezone={timezone ?? 'Asia/Taipei'}
          onClose={() => setBreaking(null)}
          onDone={onChanged}
        />
      )}
    </div>
  );
}

export function MySentence({ a, today }: { a: Assessment; today: number }) {
  if (!a.week) return <p className="text-xs text-muted">{t('drift.mine.empty')}</p>;
  return (
    <p className="text-xs leading-normal text-muted">
      {a.share === null
        ? t('drift.mine.noUnits')
        : t('drift.mine.sentence', { deg: Math.round(a.angle), pct: Math.round(a.share) })}
      {a.progress !== null &&
        ` ${t('drift.mine.progress', { pct: Math.round(a.progress), today: Math.round(today) })}`}
    </p>
  );
}

// ── D2 每個人往哪裡走 ＋ D7 方向羅盤 ─────────────────────────

function TeamView({
  team,
  rows,
  goal,
  directions,
  me,
  isAdmin,
  periods,
  weekNotes,
  onChanged,
  today,
  person,
  onBack,
  onOpen,
}: TeamTabProps & {
  team: TeamView;
  rows: Row[];
  goal: TeamGoal | null;
  today: number;
  person: (r: Row, isMe: boolean) => CompassPerson;
  onBack: () => void;
  onOpen: (member: string) => void;
}) {
  const [mode, setMode] = useState<'list' | 'compass'>('list');
  const [showTrail, setShowTrail] = useState(() => readFlag(TRAIL_KEY));
  const [showMean, setShowMean] = useState(() => readFlag(MEAN_KEY));
  const [editingNote, setEditingNote] = useState(false);
  const note = weekNotes.find((n) => n.team === team.id && n.week === periods.week) ?? null;
  const canNote = isAdmin || team.leads.includes(me);
  const active = rows.filter((r) => r.a.share !== null);
  const mean = meanAngle(active.map((r) => ({ angle: r.a.angle, side: sideOf(r.member.id) })));
  const box = useRef<HTMLDivElement>(null);
  const size = useCompassSize(box, mode === 'compass');
  const dir = directions.find((d) => d.id === goal?.directionId);
  const warn = rows.filter((r) => r.a.state === 'warn' || r.a.state === 'stale');
  const warnCount = rows.filter((r) => r.a.state === 'warn').length;
  const staleCount = warn.length - warnCount;
  const ok = rows.filter((r) => r.a.state === 'ok').length;
  const myRow = rows.find((r) => r.member.id === me);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-3 text-sm">
        <LinkButton onClick={onBack}>{t('drift.backTeams')}</LinkButton>
        <span className="text-lg font-bold">{team.name}</span>
        <span className="text-muted">{t('guide.team.people', { n: rows.length })}</span>
        <SegmentedControl
          label={t('drift.viewMode')}
          options={[
            { value: 'list', label: t('drift.view.list') },
            { value: 'compass', label: t('drift.view.compass') },
          ]}
          value={mode}
          onChange={setMode}
          className="ml-auto"
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
        <Card padding="none" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-4 px-5 pt-4 pb-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-bold text-level-quarter">
                {dir ? t('drift.teamGoalFor', { title: dir.title }) : t('guide.row.teamGoal')}
              </span>
              <span className="truncate text-lg font-bold">
                {goal?.title ?? t('guide.team.noGoal')}
              </span>
              <span className="flex items-center gap-2 text-xs">
                {note ? (
                  <span className="truncate text-muted">
                    {t('drift.note.label')}
                    {note.text}
                  </span>
                ) : (
                  canNote && <span className="text-muted">{t('drift.note.empty')}</span>
                )}
                {canNote && (
                  <LinkButton className="shrink-0 text-xs" onClick={() => setEditingNote(true)}>
                    {note ? t('guide.team.edit') : t('drift.note.write')}
                  </LinkButton>
                )}
              </span>
            </div>
            {goal && (
              <div className="flex w-50 flex-col gap-1">
                <ProgressBar value={goal.progress / 100} label={goal.title} />
                <span className="text-right text-xs text-muted">
                  {t('drift.progress', { pct: Math.round(goal.progress) })}
                </span>
              </div>
            )}
            <StatePill state="ok">{t('drift.count.ok', { n: ok })}</StatePill>
            {warnCount > 0 && (
              <StatePill state="warn">{t('drift.count.warn', { n: warnCount })}</StatePill>
            )}
            {staleCount > 0 && (
              <StatePill state="stale">{t('drift.count.stale', { n: staleCount })}</StatePill>
            )}
          </div>
          {mode === 'list' ? (
            <MemberList rows={rows} me={me} today={today} onOpen={onOpen} />
          ) : (
            <div className="flex gap-4 px-5 pb-1">
              <Switch
                size="sm"
                label={t('drift.toggle.trail')}
                checked={showTrail}
                onChange={(on) => {
                  setShowTrail(on);
                  writeFlag(TRAIL_KEY, on);
                }}
              />
              <Switch
                size="sm"
                label={t('drift.toggle.mean')}
                checked={showMean}
                onChange={(on) => {
                  setShowMean(on);
                  writeFlag(MEAN_KEY, on);
                }}
              />
            </div>
          )}
          {mode === 'compass' && (
            <div
              ref={box}
              className="flex min-h-0 flex-1 items-end justify-center overflow-hidden px-4 pb-2"
            >
              <DirectionCompass
                mode="full"
                width={size.w}
                height={size.h}
                radius={size.r}
                today={today}
                teamLabel={goal ? t('drift.compass.teamGoal', { title: goal.title }) : team.name}
                people={rows.map((r) => {
                  const p = person(r, r.member.id === me);
                  return showTrail ? p : { ...p, trail: undefined };
                })}
                onOpen={onOpen}
                mean={showMean ? mean : null}
                label={t('drift.compass.label', { team: team.name })}
              />
            </div>
          )}
          <div className="flex gap-3 border-t border-line px-5 py-2.5 text-xs text-muted">
            <span>{t('drift.list.hint')}</span>
            <span className="ml-auto">{t('drift.list.private')}</span>
          </div>
        </Card>
        {mode === 'compass' && (
          <Card className="flex w-70 shrink-0 flex-col gap-2.5 wide:w-85">
            {myRow && (
              <div className="flex flex-col gap-1 rounded-control bg-bg px-3.5 py-3">
                <span className="text-sm font-bold">
                  {myRow.a.share === null
                    ? t('drift.side.noUnits')
                    : myRow.a.state === 'ok'
                      ? t('drift.side.youOk', { deg: Math.round(myRow.a.angle) })
                      : t('drift.side.you', { deg: Math.round(myRow.a.angle) })}
                </span>
                <MySentence a={myRow.a} today={today} />
              </div>
            )}
            {showMean && mean !== null && Math.abs(mean) >= 15 && (
              <div className="rounded-control border border-level-year px-3.5 py-3 text-sm">
                {t('drift.mean.warn', { deg: Math.round(Math.abs(mean)) })}
              </div>
            )}
            {warn.length > 0 && (
              <div className="flex flex-col gap-1 rounded-control border border-warning px-3.5 py-3">
                <span className="text-sm font-bold text-warning">{t('drift.side.drifting')}</span>
                {warn.map((r) => (
                  <LinkButton
                    key={r.member.id}
                    className="self-start text-left text-sm"
                    onClick={() => onOpen(r.member.id)}
                  >
                    {r.member.name}：
                    {reasonKeys(r.a)
                      .map((k) => t(`drift.reason.${k}`))
                      .join('、')}{' '}
                    ›
                  </LinkButton>
                ))}
              </div>
            )}
            <span className="mt-1 text-sm font-bold">{t('drift.legend.title')}</span>
            {(['angle', 'length', 'zone', 'dashed', 'stale', 'trail'] as const).map((k) => (
              <div key={k} className="flex flex-col border-t border-line py-1.5">
                <span className="text-sm font-bold">{t(`drift.legend.${k}`)}</span>
                <span className="text-xs text-muted">{t(`drift.legend.${k}.hint`)}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
      {editingNote && (
        <NoteDialog
          team={team}
          week={periods.week}
          initial={note?.text ?? ''}
          onClose={() => setEditingNote(false)}
          onSaved={() => {
            setEditingNote(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

const TRAIL_KEY = 'hills.compass.trail';
const MEAN_KEY = 'hills.compass.mean';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // 忽略
  }
}

/** 負責人寫這週重點（ui-spec「目標 → 團隊」v0.23）。 */
function NoteDialog({
  team,
  week,
  initial,
  onClose,
  onSaved,
}: {
  team: TeamView;
  week: string;
  initial: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(initial);
  const { busy, error, attempt } = useAction();
  return (
    <Dialog
      title={t('drift.note.title', { team: team.name })}
      onClose={onClose}
      dirty={text !== initial}
      onSubmit={async () => {
        if (await attempt(() => api.setWeekNote(team.id, week, text))) onSaved();
      }}
    >
      <Field label={t('drift.note.field')} hint={t('drift.note.hint')}>
        <TextInput
          autoFocus
          maxLength={200}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy}>
          {t('common.save')}
        </Button>
      </div>
    </Dialog>
  );
}

/** 依容器大小決定羅盤尺寸（1280 × 720 起，寬螢幕放大）。 */
function useCompassSize(ref: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const [size, setSize] = useState({ w: 760, h: 540, r: 380 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const fit = () => {
      const w = Math.max(520, Math.min(el.clientWidth - 32, 1200));
      const h = Math.max(380, el.clientHeight - 8);
      const r = Math.round(Math.min(w / 2 - 50, (h - 150) / 0.78));
      setSize((old) => (old.w === w && old.h === h && old.r === r ? old : { w, h, r }));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return size;
}

function MemberList({
  rows,
  me,
  today,
  onOpen,
}: {
  rows: Row[];
  me: string;
  today: number;
  onOpen: (member: string) => void;
}) {
  return (
    <div className="scroll-panel min-h-0 flex-1">
      <div className="grid grid-cols-[96px_minmax(0,1fr)_140px_140px_72px_220px] gap-3.5 border-t border-line px-5 py-2 text-xs font-bold text-muted">
        <span>{t('drift.col.member')}</span>
        <span>{t('drift.col.goal')}</span>
        <span>{t('drift.col.time')}</span>
        <span>{t('drift.col.pace')}</span>
        <span>{t('drift.col.updated')}</span>
        <span>{t('drift.col.state')}</span>
      </div>
      {rows.map(({ member, a }) => {
        const g = a.week?.goals[0];
        return (
          <ListButton
            key={member.id}
            className="grid w-full grid-cols-[96px_minmax(0,1fr)_140px_140px_72px_220px] items-center gap-3.5 border-t border-line px-5 py-2.5 text-left"
            onClick={() => onOpen(member.id)}
          >
            <span className="truncate font-bold">
              {member.id === me ? t('drift.you') : member.name}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-semibold">
                {g?.title ??
                  (a.week?.privateGoals ? t('drift.privateGoals') : t('drift.tip.noGoal'))}
              </span>
              <span className={`truncate text-xs ${a.unaligned ? 'text-warning' : 'text-muted'}`}>
                {a.unaligned ? t('drift.list.unaligned') : g ? t('drift.list.aligned') : ''}
              </span>
            </span>
            <span className="flex flex-col gap-1">
              {a.share === null ? (
                <span className="text-xs text-muted">{t('drift.tip.noUnits')}</span>
              ) : (
                <>
                  <span className="flex h-2 overflow-hidden rounded-full bg-line">
                    <span className="bg-primary" style={{ width: `${a.share}%` }} />
                  </span>
                  <span className="text-xs text-muted">
                    {t('drift.list.share', { pct: Math.round(a.share) })}
                  </span>
                </>
              )}
            </span>
            <span className="flex flex-col gap-1">
              <span className="relative h-2 rounded-full bg-line">
                <span
                  className={`absolute inset-y-0 left-0 rounded-full ${a.behind ? 'bg-warning' : 'bg-primary'}`}
                  style={{ width: `${a.progress ?? 0}%` }}
                />
                <span
                  className="absolute -top-1 h-4 w-0.5 rounded-sm bg-fg"
                  style={{ left: `${today}%` }}
                />
              </span>
              <span className="text-xs text-muted">
                {a.progress === null ? '—' : t('drift.progress', { pct: Math.round(a.progress) })}
              </span>
            </span>
            <span className={`text-xs ${a.stale ? 'font-bold text-warning' : 'text-muted'}`}>
              {a.idleDays === null
                ? '—'
                : a.idleDays === 0
                  ? t('drift.today')
                  : t('drift.daysAgo', { n: a.idleDays })}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <StatePill state={a.state} />
              <Reasons a={a} />
            </span>
          </ListButton>
        );
      })}
      {rows.length === 0 && <EmptyState>{t('drift.list.empty')}</EmptyState>}
    </div>
  );
}

// ── D3 某人的方向 ──────────────────────────────────────────

function PersonView({
  team,
  row,
  goal,
  weeks,
  directions,
  rules,
  me,
  today,
  onBack,
}: TeamTabProps & {
  team: TeamView;
  row: Row;
  goal: TeamGoal | null;
  weeks: DirectionWeek[];
  today: number;
  onBack: () => void;
}) {
  const { member, a } = row;
  const self = member.id === me;
  const dir = directions.find((d) => d.id === goal?.directionId);
  const w = a.week;
  const thisWeek = weeks[0];
  const [sent, setSent] = useState(false);
  const { busy, error, attempt } = useAction();
  const target = w?.goals.find((g) => !g.alignedGoalId);
  /** `neutral`：沒有資料可判定（本週沒有完成的事），不打 ✓（ui-spec v0.24）。 */
  const check = (ok: boolean, title: string, text: string, neutral = false) => (
    <div className="flex gap-3 border-t border-line py-3">
      <span
        aria-hidden="true"
        className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${neutral ? 'border border-line text-muted' : ok ? 'bg-st-online text-surface' : 'bg-warning text-surface'}`}
      >
        {neutral ? '·' : ok ? '✓' : '!'}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className={`font-bold ${ok || neutral ? '' : 'text-warning'}`}>{title}</span>
        <span className="text-sm leading-normal text-muted">{text}</span>
      </div>
    </div>
  );
  const node = (
    label: string,
    color: string,
    title: string,
    sub: string,
    tone = 'border-line bg-surface',
  ) => (
    <div className={`flex items-center gap-3 rounded-card border px-4 py-3 ${tone}`}>
      <span className={`w-20 shrink-0 text-xs font-bold ${color}`}>{label}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-semibold">{title}</span>
        <span className="truncate text-xs text-muted">{sub}</span>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-3 text-sm">
        <LinkButton onClick={onBack}>‹ {team.name}</LinkButton>
        <span className="text-lg font-bold">
          {self ? t('drift.person.self') : t('drift.person.title', { name: member.name })}
        </span>
        <StatePill state={a.state} />
        {reasonKeys(a).length > 0 && (
          <span className="text-muted">
            {t('drift.person.reasons', { n: reasonKeys(a).length })}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
        <Card className="scroll-panel flex min-w-0 flex-1 flex-col gap-0">
          <h2 className="text-base font-bold">{t('drift.person.chain')}</h2>
          <p className="mb-3.5 text-xs text-muted">{t('drift.person.chainHint')}</p>
          {dir &&
            node(
              t('guide.row.direction'),
              'text-level-year',
              dir.title,
              t('drift.progress', { pct: Math.round(dir.progress) }),
              'border-line bg-primary-soft',
            )}
          {dir && <span aria-hidden="true" className="ml-11.5 h-3.5 w-0.5 bg-line" />}
          {goal &&
            node(
              t('guide.row.teamGoal'),
              'text-level-quarter',
              goal.title,
              `${team.name} · ${t('drift.progress', { pct: Math.round(goal.progress) })}`,
            )}
          {(w?.goals ?? []).map((g) => (
            <div key={g.id} className="flex flex-col">
              {g.alignedGoalId ? (
                <span aria-hidden="true" className="ml-11.5 h-3.5 w-0.5 bg-line" />
              ) : (
                <span className="ml-10 flex h-8 items-center gap-2.5 border-l-2 border-dashed border-warning pl-2.5 text-xs font-bold text-warning">
                  ▲ {t('drift.person.broken')}
                </span>
              )}
              {node(
                t('drift.person.quarter'),
                'text-level-quarter',
                g.title,
                t('drift.progress', { pct: Math.round(g.progress) }),
                g.alignedGoalId ? undefined : 'border-warning bg-bg',
              )}
            </div>
          ))}
          {w && w.privateGoals > 0 && (
            <p className="mt-2 text-xs text-muted">
              {t('drift.person.private', { n: w.privateGoals })}
            </p>
          )}
          <span aria-hidden="true" className="ml-11.5 h-3.5 w-0.5 bg-line" />
          {node(
            t('guide.row.week'),
            'text-level-week',
            thisWeek && thisWeek.units > 0
              ? t('drift.person.units', { n: thisWeek.units })
              : t('drift.tip.noUnits'),
            a.share === null ? '' : t('drift.list.share', { pct: Math.round(a.share) }),
          )}
        </Card>
        <Card className="flex w-85 shrink-0 flex-col wide:w-100">
          <h2 className="mb-1.5 text-base font-bold">{t('drift.person.checks')}</h2>
          {!w ? (
            <EmptyState>{t('drift.person.noData')}</EmptyState>
          ) : (
            <>
              {check(
                !a.unaligned,
                a.unaligned ? t('drift.reason.unaligned') : t('drift.check.aligned'),
                a.unaligned ? t('drift.check.unalignedText') : t('drift.check.alignedText'),
              )}
              {check(
                !a.elsewhere,
                a.elsewhere
                  ? t('drift.reason.elsewhere')
                  : a.share === null
                    ? t('drift.check.noUnits')
                    : t('drift.check.focused'),
                a.share === null
                  ? t('drift.check.noUnitsText')
                  : t('drift.check.shareText', {
                      units: thisWeek?.units ?? 0,
                      aligned: thisWeek?.alignedUnits ?? 0,
                      pct: Math.round(a.share),
                      min: rules.minAlignedShare,
                    }),
                a.share === null,
              )}
              {check(
                !a.behind,
                a.behind ? t('drift.reason.behind') : t('drift.check.onPace'),
                a.progress === null
                  ? t('drift.check.noGoalText')
                  : t('drift.check.paceText', {
                      pct: Math.round(a.progress),
                      today: Math.round(today),
                      points: rules.behindPoints,
                    }),
              )}
              {check(
                !a.stale,
                a.stale ? t('drift.reason.stale') : t('drift.check.fresh'),
                a.idleDays === null
                  ? t('drift.check.noActivity')
                  : a.idleDays === 0
                    ? t('drift.check.idleToday', { days: rules.staleDays })
                    : t('drift.check.idleText', { n: a.idleDays, days: rules.staleDays }),
              )}
            </>
          )}
          <div className="mt-auto flex flex-col gap-2.5 border-t border-line pt-3.5">
            {!self && a.unaligned && goal && target && (
              <Button
                busy={busy}
                disabled={sent}
                onClick={async () => {
                  if (await attempt(() => api.suggestAlign(member.id, target.id, goal.id)))
                    setSent(true);
                }}
              >
                {sent ? t('drift.suggest.sent') : t('drift.suggest', { title: goal.title })}
              </Button>
            )}
            <ErrorText message={error} />
            <span className="text-xs leading-normal text-muted">
              {self ? t('drift.person.selfHint') : t('drift.suggest.hint', { name: member.name })}
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
