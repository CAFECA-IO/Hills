/**
 * OGSM（ui-spec「工作 › 我的位置與 OGSM」v0.44，D65）：
 * 「我的位置」四個問題卡、一頁 OGSM（公司 / 小組）、目的與策略的編輯對話框。
 */
import { useState, type ReactNode } from 'react';
import {
  api,
  type Measure,
  type MemberView,
  type Purpose,
  type StrategyView,
  type Task,
  type TeamGoal,
  type TeamView,
} from './api';
import { DEFAULT_RULES, assess, quarterElapsed } from './drift-utils';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import { elapsedOf, hillStateOf, myRole, projectShare, type MyRole } from './ogsm-utils';
import { daysOf } from './reports-utils';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  Dialog,
  DialogFooter,
  ErrorText,
  Field,
  IconButton,
  LinkButton,
  ProgressBar,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
  useAction,
} from './ui';

const pct = (v: number) => `${Math.round(v)}%`;

/** 進度條 ＋「應到」標記（不設紅黃綠，D65）。 */
function Progress({
  value,
  expected,
  label,
}: {
  value: number;
  expected: number | null;
  label: string;
}) {
  return (
    <span className="relative block min-w-0 flex-1">
      <ProgressBar value={value / 100} label={label} size="sm" />
      {expected !== null && (
        <span
          aria-hidden
          className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-sm bg-fg"
          style={{ left: `${Math.round(expected * 100)}%` }}
        />
      )}
    </span>
  );
}

/** 卡片的題號與標題。 */
function Question({ n, children }: { n: number; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-bold">
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-control bg-primary text-xs text-on-primary"
      >
        {n}
      </span>
      {children}
    </h2>
  );
}

// ── 我的位置（O2）────────────────────────────────────────────

export function OgsmPosition({
  members,
  teams,
  tasks,
  timezone,
  onOgsm,
}: {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  timezone: string;
  /** 切到「OGSM」 */
  onOgsm: () => void;
}) {
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const [now] = useState(() => Date.now());
  const periods = periodsAt(now, timezone);
  const week = daysOf('weekly', periods.week);
  const months = [...new Set([week[0]!.slice(0, 7), week[6]!.slice(0, 7)])];
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const plans = useLoad(() => api.plans(true), ['doc', 'org', 'roster']);
  const summaries = useLoad(api.directionSummaries, ['doc', 'org', 'roster']);
  const rules = useLoad(api.directionRules, ['org']);
  const worklog = useLoad(
    () => (meId ? api.worklogDays(meId, months) : Promise.resolve([])),
    ['doc'],
  );
  if (!dirs.data || !plans.data) return null;
  const view = dirs.data;
  const items = plans.data;
  const thisWeekGoals = new Set(
    items.filter((p) => p.mine && p.level === 'week' && p.period === periods.week).map((p) => p.id),
  );
  const role = myRole(view, teams, items, tasks, meId, periods.year, thisWeekGoals);
  const purpose = view.purpose ?? null;
  const yearDirs = view.directions.filter((d) => d.year === periods.year);
  const yearElapsed = elapsedOf(periods.year, periods.day);
  const share = projectShare(worklog.data ?? [], week);
  const a = assess(
    summaries.data?.find((m) => m.member === meId)?.weeks,
    rules.data ?? DEFAULT_RULES,
    periods,
    now,
  );
  const hill = hillStateOf(a);
  const quarterGoals = items.filter(
    (p) => p.mine && p.level === 'quarter' && p.period === periods.quarter,
  );
  const qProgress = quarterGoals.length
    ? quarterGoals.reduce((n, p) => n + p.progress, 0) / quarterGoals.length
    : null;
  return (
    <div className="grid shrink-0 grid-cols-4 gap-3 wide:gap-4">
      <Card padding="sm" className="flex flex-col gap-2">
        <Question n={1}>{t('ogsm.q1')}</Question>
        {purpose ? (
          <p className="line-clamp-3 text-sm font-semibold">{purpose.title}</p>
        ) : (
          <p className="text-xs text-muted">{t('ogsm.noPurpose')}</p>
        )}
        <ul className="flex flex-col gap-1.5">
          {yearDirs.slice(0, 3).map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-xs">
              <span className="w-24 truncate" title={d.title}>
                {d.title}
              </span>
              <Progress value={d.progress} expected={yearElapsed} label={d.title} />
              <span className="w-8 text-right">{pct(d.progress)}</span>
            </li>
          ))}
        </ul>
        <LinkButton className="mt-auto self-start text-xs" onClick={onOgsm}>
          {t('ogsm.seeAll')}
        </LinkButton>
      </Card>
      <Card padding="sm" className="flex flex-col gap-2">
        <Question n={2}>{t('ogsm.q2')}</Question>
        <p className="line-clamp-3 text-sm">{purpose?.why || t('ogsm.noWhy')}</p>
        {role.purposes.slice(0, 1).map((p) => (
          <p key={p.team} className="line-clamp-2 border-l-2 border-primary pl-2 text-xs">
            <span className="font-semibold">
              {teams.find((x) => x.id === p.team)?.name ?? ''}：
            </span>
            {p.title}
          </p>
        ))}
      </Card>
      <Card padding="sm" className="flex flex-col gap-2">
        <Question n={3}>{t('ogsm.q3')}</Question>
        <RoleLines role={role} />
      </Card>
      <Card padding="sm" className="flex flex-col gap-1.5">
        <Question n={4}>{t('ogsm.q4')}</Question>
        <Signal label={t('ogsm.sig.time')} value={share === null ? '—' : pct(share)} />
        <Signal label={t('ogsm.sig.aligned')} value={`${role.aligned.length} / ${role.myGoals}`} />
        <Signal
          label={t('ogsm.sig.quarter')}
          value={
            qProgress === null
              ? '—'
              : t('ogsm.sig.quarterValue', {
                  p: pct(qProgress),
                  e: pct(quarterElapsed(periods) * 100),
                })
          }
        />
        <Signal label={t('ogsm.sig.hill')} value={t(`ogsm.hill.${hill}` as MessageKey)} />
        {role.owned.flatMap((s) =>
          s.measures
            .slice(0, 2)
            .map((m, i) => (
              <Signal
                key={`${s.id}:${m.id}`}
                label={m.title}
                value={pct(s.measureProgress[i] ?? 0)}
              />
            )),
        )}
      </Card>
    </div>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
      <span className="shrink-0 font-semibold">{value}</span>
    </p>
  );
}

function RoleLines({ role }: { role: MyRole }) {
  if (role.teams.length === 0) return <p className="text-xs text-muted">{t('ogsm.role.noTeam')}</p>;
  const strategy = role.owned[0] ?? role.strategies[0];
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p>
        <Badge>{role.teams.map((x) => x.name).join('、')}</Badge>
      </p>
      {strategy ? (
        <p className="line-clamp-2">
          {role.owned.length > 0 ? t('ogsm.role.owner') : t('ogsm.role.strategy')}
          <span className="font-semibold">{strategy.title}</span>
        </p>
      ) : (
        <p className="text-muted">{t('ogsm.role.noStrategy')}</p>
      )}
      <p>
        {role.aligned.length > 0
          ? t('ogsm.role.goals', { n: role.aligned.length, title: role.aligned[0]!.title })
          : t('ogsm.role.noGoals')}
      </p>
      <p className="text-muted">{t('ogsm.role.week', { n: role.weekTasks })}</p>
    </div>
  );
}

/** 首頁小卡「我們往哪裡去」。 */
export function OgsmHomeCard({
  members,
  teams,
  onOpen,
}: {
  members: MemberView[];
  teams: TeamView[];
  onOpen: () => void;
}) {
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const purpose = dirs.data?.purpose;
  if (!dirs.data || !purpose) return null;
  const mine = teams.filter((x) => x.members.includes(me) || x.leads.includes(me));
  const strategies = (dirs.data.strategies ?? []).filter((s) => mine.some((x) => x.id === s.team));
  const strategy = strategies.find((s) => s.owners.includes(me)) ?? strategies[0];
  const team = mine.find((x) => x.id === strategy?.team) ?? mine[0];
  return (
    <Card padding="sm" className="flex flex-col gap-1">
      <span className="text-xs font-bold text-muted">{t('ogsm.home.title')}</span>
      <p className="line-clamp-2 text-sm font-semibold">{purpose.title}</p>
      {team && strategy && (
        <p className="truncate text-xs text-muted">
          {t('ogsm.home.role', { team: team.name, strategy: strategy.title })}
        </p>
      )}
      <LinkButton className="self-start text-xs" onClick={onOpen}>
        {t('ogsm.home.open')}
      </LinkButton>
    </Card>
  );
}

// ── 一頁 OGSM（O1）──────────────────────────────────────────

export function OgsmPage({
  members,
  teams,
  timezone,
  headExtra,
}: {
  members: MemberView[];
  teams: TeamView[];
  timezone: string;
  headExtra: ReactNode;
}) {
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const isAdmin = me?.isAdmin ?? false;
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const plans = useLoad(() => api.plans(true), ['doc', 'org', 'roster']);
  const tasks = useLoad(api.tasks, ['doc', 'org', 'roster']);
  const [now] = useState(() => Date.now());
  const periods = periodsAt(now, timezone);
  const active = teams;
  const mine = active.filter((x) => x.members.includes(meId) || x.leads.includes(meId));
  const [scope, setScope] = useState<string>('company');
  const [editing, setEditing] = useState<
    { kind: 'purpose' } | { kind: 'strategy'; item: StrategyView | null } | null
  >(null);
  const view = dirs.data;
  const team = active.find((x) => x.id === scope) ?? null;
  const canEdit = team ? isAdmin || team.leads.includes(meId) : isAdmin;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '?';
  const reload = () => dirs.reload();

  const head = (
    <PageHead
      title={t('goals.title')}
      actions={
        <>
          {headExtra}
          {canEdit && (
            <Button variant="secondary" onClick={() => setEditing({ kind: 'purpose' })}>
              {t('ogsm.editPurpose')}
            </Button>
          )}
          {canEdit && team && (
            <Button onClick={() => setEditing({ kind: 'strategy', item: null })}>
              {t('ogsm.addStrategy')}
            </Button>
          )}
        </>
      }
    />
  );
  if (!view) {
    return (
      <div className="flex h-full flex-col gap-3">
        {head}
        <ErrorText message={dirs.error} />
      </div>
    );
  }
  const purpose: Purpose | null = team
    ? ((view.teamPurposes ?? []).find((p) => p.team === team.id) ?? null)
    : (view.purpose ?? null);
  const goals = team
    ? view.teamGoals.filter((g) => g.team === team.id && g.year === periods.year)
    : view.directions.filter((d) => d.year === periods.year);
  const expected = elapsedOf(periods.year, periods.day);
  // 公司層：策略 = 對齊公司目標的小組目標；小組層：策略 = strategy:*
  const companyRows = view.teamGoals.filter(
    (g) => g.year === periods.year && g.directionId && goals.some((d) => d.id === g.directionId),
  );
  const strategies = team ? (view.strategies ?? []).filter((s) => s.team === team.id) : [];
  const planCount = (goalIds: string[]) => {
    const aligned = (plans.data ?? []).filter(
      (p) => p.alignedGoalId && goalIds.includes(p.alignedGoalId),
    );
    const weekTasks = (tasks.data ?? []).filter(
      (x) => x.status !== 'done' && x.teamGoalId !== null && goalIds.includes(x.teamGoalId),
    );
    return { goals: aligned.length, tasks: weekTasks.length };
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {head}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label={t('ogsm.scope')}
          options={[
            { value: 'company', label: t('ogsm.scope.company') },
            ...mine.map((x) => ({ value: x.id, label: x.name })),
          ]}
          value={mine.some((x) => x.id === scope) || scope === 'company' ? scope : 'company'}
          onChange={setScope}
        />
        {active.length > mine.length && (
          <Select
            size="sm"
            className="w-auto"
            aria-label={t('ogsm.otherTeams')}
            value={mine.some((x) => x.id === scope) || scope === 'company' ? '' : scope}
            onChange={(e) => e.target.value && setScope(e.target.value)}
          >
            <option value="">{t('ogsm.otherTeams')}</option>
            {active
              .filter((x) => !mine.includes(x))
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </Select>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-3 wide:grid-cols-[380px_minmax(0,1fr)] wide:gap-4">
        <div className="scroll-panel flex min-h-0 flex-col gap-3">
          <Card className="flex flex-col gap-2 bg-primary-soft">
            <span className="text-xs font-bold text-primary">
              {t('ogsm.purpose')}
              {purpose?.period ? ` · ${purpose.period}` : ''}
            </span>
            {purpose ? (
              <>
                <p className="text-lg font-bold">{purpose.title}</p>
                {purpose.why && (
                  <div className="flex flex-col gap-1 rounded-control bg-surface p-3 text-sm">
                    <span className="text-xs font-bold text-primary">{t('ogsm.why')}</span>
                    <p className="whitespace-pre-line">{purpose.why}</p>
                  </div>
                )}
                {team && purpose.goalIds.length > 0 && (
                  <p className="text-xs text-muted">
                    {t('ogsm.serves', {
                      goals: purpose.goalIds
                        .map((g) => view.directions.find((d) => d.id === g)?.title)
                        .filter(Boolean)
                        .join('、'),
                    })}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">
                {team ? t('ogsm.noTeamPurpose') : t('ogsm.noPurpose')}
              </p>
            )}
          </Card>
          <Card className="flex flex-col gap-2">
            <h2 className="text-sm font-bold">
              {team
                ? t('ogsm.teamGoals', { year: periods.year })
                : t('ogsm.companyGoals', { year: periods.year })}
            </h2>
            {goals.length === 0 && <p className="text-xs text-muted">{t('ogsm.noGoals')}</p>}
            {goals.map((g) => (
              <div
                key={g.id}
                className="flex flex-col gap-1 border-b border-line pb-2 last:border-0"
              >
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 flex-1 font-semibold">{g.title}</span>
                  <span className="text-xs">{pct(g.progress)}</span>
                </span>
                <Progress value={g.progress} expected={expected} label={g.title} />
              </div>
            ))}
            <span className="text-xs text-muted">{t('ogsm.expectedHint')}</span>
          </Card>
        </div>

        <Card className="scroll-panel flex min-h-0 flex-col gap-0 p-0">
          <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_150px] border-b border-line bg-bg px-4 py-2 text-xs font-bold text-muted">
            <span>{t('ogsm.col.strategy')}</span>
            <span>{t('ogsm.col.measures')}</span>
            <span>{t('ogsm.col.plan')}</span>
          </div>
          {(team ? strategies.length : companyRows.length) === 0 && (
            <p className="p-4 text-sm text-muted">
              {team
                ? canEdit
                  ? t('ogsm.noStrategiesLead')
                  : t('ogsm.noStrategies')
                : t('ogsm.noCompanyStrategies')}
            </p>
          )}
          {team
            ? strategies.map((s) => {
                const c = planCount(s.goalIds);
                return (
                  <Row
                    key={s.id}
                    left={
                      <>
                        <span className="flex items-center gap-2">
                          <span className="font-bold">{s.title}</span>
                          {canEdit && (
                            <IconButton
                              size="sm"
                              label={t('ogsm.editStrategy', { title: s.title })}
                              onClick={() => setEditing({ kind: 'strategy', item: s })}
                            >
                              ✎
                            </IconButton>
                          )}
                        </span>
                        {s.how && <span className="text-xs text-muted">{s.how}</span>}
                        <span className="text-xs text-muted">
                          {t('ogsm.toGoals', {
                            goals: s.goalIds
                              .map((g) => view.teamGoals.find((x) => x.id === g)?.title)
                              .filter(Boolean)
                              .join('、'),
                          })}
                          {s.owners.length > 0 &&
                            ` · ${t('ogsm.owners', { names: s.owners.map(nameOf).join('、') })}`}
                        </span>
                        <span className="flex items-center gap-2 text-xs">
                          <span className="text-muted">
                            {t('ogsm.progress', { p: pct(s.progress) })}
                          </span>
                          <Progress value={s.progress} expected={expected} label={s.title} />
                        </span>
                      </>
                    }
                    measures={s.measures.map((m, i) => ({
                      id: m.id,
                      title: m.title,
                      value: measureText(m, s.measureProgress[i] ?? 0),
                      progress: s.measureProgress[i] ?? 0,
                      auto: m.source.kind === 'goal',
                    }))}
                    plan={c}
                    expected={expected}
                  />
                );
              })
            : companyRows.map((g) => (
                <Row
                  key={g.id}
                  left={
                    <>
                      <span className="flex items-center gap-2">
                        <Badge>{teams.find((x) => x.id === g.team)?.name ?? ''}</Badge>
                        <span className="font-bold">{g.title}</span>
                      </span>
                      <span className="text-xs text-muted">
                        {t('ogsm.toGoals', {
                          goals: view.directions.find((d) => d.id === g.directionId)?.title ?? '',
                        })}
                      </span>
                    </>
                  }
                  measures={[
                    {
                      id: g.id,
                      title: t('ogsm.teamGoalProgress'),
                      value: pct(g.progress),
                      progress: g.progress,
                      auto: true,
                    },
                  ]}
                  plan={planCount([g.id])}
                  expected={expected}
                />
              ))}
          <p className="mt-auto px-4 py-3 text-xs text-muted">{t('ogsm.footnote')}</p>
        </Card>
      </div>
      {editing?.kind === 'purpose' && (
        <PurposeDialog
          team={team}
          purpose={purpose}
          directions={view.directions.filter((d) => d.year === periods.year)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {editing?.kind === 'strategy' && team && (
        <StrategyDialog
          team={team}
          item={editing.item}
          goals={view.teamGoals.filter((g) => g.team === team.id)}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function measureText(m: Measure, progress: number): string {
  if (m.source.kind === 'manual') {
    const u = m.source.unit ?? '';
    return `${m.source.current}${u} / ${m.source.target}${u}`;
  }
  return pct(progress);
}

function Row({
  left,
  measures,
  plan,
  expected,
}: {
  left: ReactNode;
  measures: { id: string; title: string; value: string; progress: number; auto: boolean }[];
  plan: { goals: number; tasks: number };
  expected: number | null;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_150px] gap-3 border-b border-line px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">{left}</div>
      <ul className="flex min-w-0 flex-col gap-2">
        {measures.length === 0 && <li className="text-xs text-muted">{t('ogsm.noMeasures')}</li>}
        {measures.map((m) => (
          <li key={m.id} className="flex flex-col gap-1">
            <span className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <span className="font-semibold">{m.value}</span>
              <span className="text-xs text-muted">
                {m.auto ? t('ogsm.auto') : t('ogsm.manual')}
              </span>
            </span>
            <Progress value={m.progress} expected={expected} label={m.title} />
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-0.5 text-xs">
        <span>{t('ogsm.plan.goals', { n: plan.goals })}</span>
        <span>{t('ogsm.plan.tasks', { n: plan.tasks })}</span>
      </div>
    </div>
  );
}

// ── 編輯 ───────────────────────────────────────────────────

function PurposeDialog({
  team,
  purpose,
  directions,
  onClose,
  onSaved,
}: {
  team: TeamView | null;
  purpose: Purpose | null;
  directions: { id: string; title: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(purpose?.title ?? '');
  const [why, setWhy] = useState(purpose?.why ?? '');
  const [period, setPeriod] = useState(purpose?.period ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(purpose?.goalIds ?? []);
  const [titleError, setTitleError] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const dirty =
    title !== (purpose?.title ?? '') ||
    why !== (purpose?.why ?? '') ||
    period !== (purpose?.period ?? '');
  const save = async () => {
    if (!title.trim()) {
      setTitleError(t('ogsm.err.title'));
      return;
    }
    const input = { title, why, period, goalIds: team ? goalIds : [] };
    if (
      await attempt(() => (team ? api.saveTeamPurpose(team.id, input) : api.saveOrgPurpose(input)))
    )
      onSaved();
  };
  return (
    <Dialog
      title={team ? t('ogsm.dlg.teamPurpose', { team: team.name }) : t('ogsm.dlg.purpose')}
      onClose={onClose}
      onSubmit={() => void save()}
      dirty={dirty}
      footer={
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      }
    >
      <Field label={t('ogsm.f.title')} hint={t('ogsm.f.titleHint')} required error={titleError}>
        <TextInput
          autoFocus
          maxLength={120}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleError(null);
          }}
        />
      </Field>
      <Field label={t('ogsm.f.why')} hint={t('ogsm.f.whyHint')}>
        <TextArea
          maxLength={1000}
          className="min-h-24"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
        />
      </Field>
      <Field label={t('ogsm.f.period')} hint={t('ogsm.f.periodHint')}>
        <TextInput maxLength={20} value={period} onChange={(e) => setPeriod(e.target.value)} />
      </Field>
      {team && directions.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-muted">{t('ogsm.f.serves')}</legend>
          {directions.map((d) => (
            <Checkbox
              key={d.id}
              label={d.title}
              checked={goalIds.includes(d.id)}
              onChange={() =>
                setGoalIds((g) => (g.includes(d.id) ? g.filter((x) => x !== d.id) : [...g, d.id]))
              }
            />
          ))}
        </fieldset>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}

type MeasureDraft = {
  id: string;
  title: string;
  kind: 'goal' | 'kr' | 'manual';
  goalId: string;
  krId: string;
  current: string;
  target: string;
  unit: string;
};

function toDraft(m: Measure, fallbackGoal: string): MeasureDraft {
  const s = m.source;
  return {
    id: m.id,
    title: m.title,
    kind: s.kind === 'manual' ? 'manual' : s.krId ? 'kr' : 'goal',
    goalId: s.kind === 'goal' ? s.goalId : fallbackGoal,
    krId: s.kind === 'goal' ? (s.krId ?? '') : '',
    current: s.kind === 'manual' ? String(s.current) : '',
    target: s.kind === 'manual' ? String(s.target) : '',
    unit: s.kind === 'manual' ? (s.unit ?? '') : '',
  };
}

function fromDraft(d: MeasureDraft): Measure {
  return {
    id: d.id,
    title: d.title,
    source:
      d.kind === 'manual'
        ? {
            kind: 'manual',
            current: Number(d.current) || 0,
            target: Number(d.target) || 0,
            unit: d.unit.trim() || null,
          }
        : { kind: 'goal', goalId: d.goalId, krId: d.kind === 'kr' ? d.krId || null : null },
  };
}

function StrategyDialog({
  team,
  item,
  goals,
  members,
  onClose,
  onSaved,
}: {
  team: TeamView;
  item: StrategyView | null;
  goals: TeamGoal[];
  members: MemberView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const firstGoal = goals[0]?.id ?? '';
  const [title, setTitle] = useState(item?.title ?? '');
  const [how, setHow] = useState(item?.how ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(item?.goalIds ?? (firstGoal ? [firstGoal] : []));
  const [owners, setOwners] = useState<string[]>(item?.owners ?? []);
  const [measures, setMeasures] = useState<MeasureDraft[]>(
    (item?.measures ?? []).map((m) => toDraft(m, firstGoal)),
  );
  const [errs, setErrs] = useState<{ title?: string; goals?: string; measures?: string }>({});
  const { busy, error, attempt } = useAction();
  const people = members.filter((m) => team.members.includes(m.id) || team.leads.includes(m.id));
  const setM = (i: number, p: Partial<MeasureDraft>) =>
    setMeasures((ms) => ms.map((m, k) => (k === i ? { ...m, ...p } : m)));
  const save = async () => {
    const next: typeof errs = {};
    if (!title.trim()) next.title = t('ogsm.err.title');
    if (goalIds.length === 0) next.goals = t('ogsm.err.goals');
    if (
      measures.some(
        (m) =>
          !m.title.trim() ||
          (m.kind === 'manual' && !(Number(m.target) > 0)) ||
          (m.kind === 'kr' && !m.krId),
      )
    )
      next.measures = t('ogsm.err.measures');
    setErrs(next);
    if (Object.keys(next).length > 0) return;
    if (
      await attempt(() =>
        api.saveStrategy({
          id: item?.id ?? null,
          team: team.id,
          title,
          how: how || null,
          goalIds,
          owners,
          measures: measures.map(fromDraft),
        }),
      )
    )
      onSaved();
  };
  return (
    <Dialog
      title={item ? t('ogsm.dlg.editStrategy') : t('ogsm.dlg.newStrategy')}
      width="lg"
      onClose={onClose}
      onSubmit={() => void save()}
      dirty
      footer={
        <DialogFooter
          start={
            item && (
              <ConfirmButton
                label={t('ogsm.deleteStrategy')}
                message={t('ogsm.deleteStrategy.confirm', { title: item.title })}
                onConfirm={async () => {
                  if (await attempt(() => api.deleteStrategy(team.id, item.id))) onSaved();
                }}
              />
            )
          }
        >
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      }
    >
      <Field label={t('ogsm.f.strategy')} required error={errs.title}>
        <TextInput
          autoFocus
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t('ogsm.f.how')} hint={t('ogsm.f.howHint')}>
        <TextInput maxLength={300} value={how} onChange={(e) => setHow(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted">{t('ogsm.f.goals')}</legend>
        {goals.length === 0 && <p className="text-xs text-muted">{t('ogsm.noGoals')}</p>}
        {goals.map((g) => (
          <Checkbox
            key={g.id}
            label={`${g.year} · ${g.title}`}
            checked={goalIds.includes(g.id)}
            onChange={() =>
              setGoalIds((v) => (v.includes(g.id) ? v.filter((x) => x !== g.id) : [...v, g.id]))
            }
          />
        ))}
        {errs.goals && (
          <p role="alert" className="text-xs text-danger">
            {errs.goals}
          </p>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted">{t('ogsm.f.owners')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {people.map((m) => (
            <Checkbox
              key={m.id}
              label={m.name}
              checked={owners.includes(m.id)}
              onChange={() =>
                setOwners((v) => (v.includes(m.id) ? v.filter((x) => x !== m.id) : [...v, m.id]))
              }
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted">{t('ogsm.f.measures')}</legend>
        {measures.map((m, i) => {
          const goal = goals.find((g) => g.id === m.goalId);
          return (
            <div key={i} className="flex flex-col gap-2 rounded-control border border-line p-3">
              <div className="flex items-center gap-2">
                <TextInput
                  className="flex-1"
                  aria-label={t('ogsm.f.measureTitle')}
                  placeholder={t('ogsm.f.measureTitle')}
                  maxLength={80}
                  value={m.title}
                  onChange={(e) => setM(i, { title: e.target.value })}
                />
                <Select
                  size="sm"
                  className="w-auto"
                  aria-label={t('ogsm.f.source')}
                  value={m.kind}
                  onChange={(e) => setM(i, { kind: e.target.value as MeasureDraft['kind'] })}
                >
                  <option value="goal">{t('ogsm.src.goal')}</option>
                  <option value="kr">{t('ogsm.src.kr')}</option>
                  <option value="manual">{t('ogsm.src.manual')}</option>
                </Select>
                <IconButton
                  size="sm"
                  label={t('ogsm.removeMeasure')}
                  onClick={() => setMeasures((ms) => ms.filter((_, k) => k !== i))}
                >
                  ×
                </IconButton>
              </div>
              {m.kind === 'manual' ? (
                <div className="grid grid-cols-3 gap-2">
                  <TextInput
                    type="number"
                    aria-label={t('ogsm.f.current')}
                    placeholder={t('ogsm.f.current')}
                    value={m.current}
                    onChange={(e) => setM(i, { current: e.target.value })}
                  />
                  <TextInput
                    type="number"
                    aria-label={t('ogsm.f.target')}
                    placeholder={t('ogsm.f.target')}
                    value={m.target}
                    onChange={(e) => setM(i, { target: e.target.value })}
                  />
                  <TextInput
                    maxLength={10}
                    aria-label={t('ogsm.f.unit')}
                    placeholder={t('ogsm.f.unit')}
                    value={m.unit}
                    onChange={(e) => setM(i, { unit: e.target.value })}
                  />
                </div>
              ) : (
                <div className="flex gap-2">
                  <Select
                    size="sm"
                    className="flex-1"
                    aria-label={t('ogsm.src.goal')}
                    value={m.goalId}
                    onChange={(e) => setM(i, { goalId: e.target.value, krId: '' })}
                  >
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </Select>
                  {m.kind === 'kr' && (
                    <Select
                      size="sm"
                      className="flex-1"
                      aria-label={t('ogsm.src.kr')}
                      value={m.krId}
                      onChange={(e) => setM(i, { krId: e.target.value })}
                    >
                      <option value="">{t('ogsm.f.pickKr')}</option>
                      {(goal?.keyResults ?? []).map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.title}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {errs.measures && (
          <p role="alert" className="text-xs text-danger">
            {errs.measures}
          </p>
        )}
        {measures.length < 5 && (
          <LinkButton
            className="self-start text-sm"
            onClick={() =>
              setMeasures((ms) => [
                ...ms,
                {
                  id: '',
                  title: '',
                  kind: 'goal',
                  goalId: goalIds[0] ?? firstGoal,
                  krId: '',
                  current: '',
                  target: '',
                  unit: '',
                },
              ])
            }
          >
            {t('ogsm.addMeasure')}
          </LinkButton>
        )}
      </fieldset>
      <ErrorText message={error} />
    </Dialog>
  );
}
