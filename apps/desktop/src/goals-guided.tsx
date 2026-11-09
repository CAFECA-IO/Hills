/**
 * 引導式目標（ui-spec「目標」v0.19，D47；設計畫布方案 C 與 D 方案）：
 * 我的 · 首頁（提示卡、從團隊方向到這一週、這一週的任務）、這一週、團隊分頁，
 * 以及規劃精靈 / 分到下一層 / 設定小組方向（goals-wizard.tsx）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  isPrivateTask,
  PRIVATE_TEAM,
  type Direction,
  type DirectionRules,
  type DirectionWeek,
  type MemberView,
  type SuggestionView,
  type PlanLevel,
  type PlanView,
  type Task,
  type TaskInput,
  type TeamGoal,
} from './api';
import { chain, nextPrompt, openCount, type ChainRow, type Prompt } from './goals-guided-utils';
import type { GoalsProps } from './goals-roadmap';
import { periodsAt, weekRange, splitPeriod, type Periods } from './goals-utils';
import { BreakdownWizard, GuidedEditor, PlanWizard, TeamGoalWizard } from './goals-wizard';
import { useLoad } from './hooks';
import { DEFAULT_RULES, assess, quarterElapsed, sideOf } from './drift-utils';
import { DirectionCompass } from './compass';
import { MySentence, StatePill, TeamTab } from './team-direction';
import { lookOf } from './summit';
import { WeeklyCheck, weeklySeen } from './weekly-check';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorText,
  IconButton,
  LinkButton,
  ProgressBar,
  SegmentedControl,
  Select,
  TextInput,
  Toast,
  useAction,
} from './ui';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DISMISS_KEY = 'hills.goals.promptDismissed';

/** 鏈上每層的文字顏色（設計 token）。 */
const ROW_BG: Record<ChainRow['kind'], string> = {
  direction: 'bg-level-year',
  teamGoal: 'bg-muted',
  year: 'bg-level-year',
  quarter: 'bg-level-quarter',
  month: 'bg-level-month',
  week: 'bg-level-week',
  day: 'bg-level-day',
};

const ROW_TEXT: Record<ChainRow['kind'], string> = {
  direction: 'text-level-year',
  teamGoal: 'text-muted',
  year: 'text-level-year',
  quarter: 'text-level-quarter',
  month: 'text-level-month',
  week: 'text-level-week',
  day: 'text-level-day',
};

export type GuidedView =
  | { kind: 'home' }
  | { kind: 'week' }
  | { kind: 'weekly' }
  | { kind: 'plan'; year: string }
  | { kind: 'breakdown'; parentId: string }
  | { kind: 'teamGoal'; team: string; goal: TeamGoal | null };

export interface ToastState {
  message: string;
  undo?: () => Promise<unknown>;
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(day: string) {
  try {
    localStorage.setItem(DISMISS_KEY, day);
  } catch {
    // 忽略
  }
}

/** 把任務轉回 TaskInput（勾選完成、連到週目標時整筆更新）。 */
export function taskInput(task: Task, patch: Partial<TaskInput> = {}): TaskInput {
  return {
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    dueAt: task.dueAt,
    steps: task.steps.map((s) => ({
      id: s.id,
      title: s.title,
      assignee: s.assignee,
      done: s.done,
    })),
    planItemId: task.planItemId,
    ...patch,
  };
}

export function GuidedGoals({
  members,
  teams,
  tasks,
  timezone,
  toggle,
  onAdvanced,
}: GoalsProps & { toggle: ReactNode; onAdvanced: () => void }) {
  const plans = useLoad(() => api.plans(true), ['doc', 'org', 'roster']);
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const summaries = useLoad(api.directionSummaries, ['doc', 'org', 'roster']);
  const rules = useLoad(api.directionRules, ['org']);
  const suggestions = useLoad(api.mySuggestions, ['doc', 'org', 'roster']);
  const weekNotes = useLoad(api.weekNotes, ['doc', 'org', 'roster']);
  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [view, setView] = useState<GuidedView>({ kind: 'home' });
  const [weeklyDismissed, setWeeklyDismissed] = useState(false);
  const [editing, setEditing] = useState<PlanView | null>(null);
  const [toast, setToast] = useState<(ToastState & { key: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const periods = periodsAt(now, timezone);
  const me = members.find((m) => m.isMe);
  const meId = me?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(meId) || x.leads.includes(meId));
  const items = useMemo(() => plans.data ?? [], [plans.data]);
  const directions = dirs.data?.directions ?? [];
  const teamGoals = dirs.data?.teamGoals ?? [];
  const reload = () => {
    plans.reload();
    dirs.reload();
    weekNotes.reload();
  };
  // 週一方向時刻：本週第一次打開目標頁時先顯示（「稍後再看」只在這次開啟內不再自動顯示）
  const ready = Boolean(me && plans.data && summaries.data && weekNotes.data);
  const showWeekly =
    view.kind === 'weekly' ||
    (view.kind === 'home' && ready && !weeklyDismissed && !weeklySeen(periods.week));
  const notify = (s: ToastState) => setToast({ ...s, key: Date.now() });
  const home = () => {
    setView({ kind: 'home' });
    reload();
  };
  const shared = { members, teams, myTeams, timezone, items, directions, teamGoals, me: meId };

  if (view.kind === 'plan') {
    return (
      <PlanWizard
        {...shared}
        year={view.year}
        now={periods}
        onCancel={() => setView({ kind: 'home' })}
        onDone={(s) => {
          notify(s);
          home();
        }}
      />
    );
  }
  if (view.kind === 'breakdown') {
    const parent = items.find((i) => i.id === view.parentId);
    if (parent) {
      return (
        <BreakdownWizard
          {...shared}
          parent={parent}
          onCancel={() => setView({ kind: 'home' })}
          onDone={(s) => {
            notify(s);
            home();
          }}
        />
      );
    }
  }
  if (view.kind === 'teamGoal') {
    return (
      <TeamGoalWizard
        {...shared}
        team={view.team}
        goal={view.goal}
        year={view.goal?.year ?? String(Number(periods.year) + 1)}
        onCancel={() => setView({ kind: 'home' })}
        onDone={(s) => {
          notify(s);
          setTab('team');
          home();
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead
        title={t('goals.title')}
        actions={
          <>
            <SegmentedControl
              label={t('guide.scope')}
              options={[
                { value: 'mine', label: t('guide.tab.mine') },
                { value: 'team', label: t('guide.tab.team') },
              ]}
              value={tab}
              onChange={(v) => {
                setTab(v);
                setView({ kind: 'home' });
              }}
            />
            {toggle}
          </>
        }
      />
      <ErrorText message={plans.error ?? dirs.error} />
      {tab === 'team' ? (
        <TeamTab
          directions={directions}
          teamGoals={teamGoals}
          teams={teams}
          members={members}
          summaries={summaries.data ?? []}
          rules={rules.data ?? DEFAULT_RULES}
          weekNotes={weekNotes.data ?? []}
          me={meId}
          isAdmin={me?.isAdmin ?? false}
          periods={periods}
          now={now}
          onEditGoal={(team, goal) => setView({ kind: 'teamGoal', team, goal })}
          onChanged={reload}
          timezone={timezone}
        />
      ) : showWeekly && me ? (
        <WeeklyCheck
          me={me}
          members={members}
          teams={teams}
          weeks={summaries.data?.find((m) => m.member === meId)?.weeks ?? []}
          rules={rules.data ?? DEFAULT_RULES}
          plans={items}
          tasks={tasks}
          weekNotes={weekNotes.data ?? []}
          periods={periods}
          timezone={timezone}
          onLater={() => {
            setWeeklyDismissed(true);
            setView({ kind: 'home' });
          }}
          onDone={() => {
            setWeeklyDismissed(true);
            home();
          }}
          notify={notify}
        />
      ) : view.kind === 'week' ? (
        <WeekView
          periods={periods}
          now={now}
          items={items}
          tasks={tasks}
          teams={myTeams}
          members={members}
          me={meId}
          onBack={() => setView({ kind: 'home' })}
          notify={notify}
        />
      ) : (
        <Home
          periods={periods}
          items={items}
          tasks={tasks}
          me={meId}
          members={members}
          directions={directions}
          teamGoals={teamGoals}
          onPlanYear={(year) => setView({ kind: 'plan', year })}
          onBreakdown={(parentId) => setView({ kind: 'breakdown', parentId })}
          onWeek={() => setView({ kind: 'week' })}
          onEdit={setEditing}
          onAll={onAdvanced}
          direction={
            <YourDirection
              weeks={summaries.data?.find((m) => m.member === meId)?.weeks ?? []}
              rules={rules.data ?? DEFAULT_RULES}
              periods={periods}
              now={now}
              me={me ?? null}
              teamName={myTeams[0]?.name ?? ''}
              onWeekly={() => setView({ kind: 'weekly' })}
            />
          }
          suggestion={
            <SuggestionCard
              suggestions={suggestions.data ?? []}
              items={items}
              members={members}
              teamGoals={teamGoals}
              directions={directions}
              notify={notify}
              onApplied={reload}
            />
          }
        />
      )}
      {editing && (
        <GuidedEditor
          {...shared}
          item={editing}
          onBreakdown={
            editing.mine && editing.level !== 'week'
              ? () => {
                  setEditing(null);
                  setView({ kind: 'breakdown', parentId: editing.id });
                }
              : undefined
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          action={
            toast.undo
              ? {
                  label: t('guide.undo'),
                  onClick: () => {
                    void toast.undo?.().then(reload);
                  },
                }
              : undefined
          }
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

// ── 我的 · 首頁 ───────────────────────────────────────────

function Home({
  periods,
  items,
  tasks,
  me,
  members,
  directions,
  teamGoals,
  onPlanYear,
  onBreakdown,
  onWeek,
  onEdit,
  onAll,
  direction,
  suggestion,
}: {
  direction: ReactNode;
  suggestion: ReactNode;
  periods: Periods;
  items: PlanView[];
  tasks: Task[];
  me: string;
  members: MemberView[];
  directions: Direction[];
  teamGoals: TeamGoal[];
  onPlanYear: (year: string) => void;
  onBreakdown: (parentId: string) => void;
  onWeek: () => void;
  onEdit: (item: PlanView) => void;
  onAll: () => void;
}) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [picked, setPicked] = useState<Partial<Record<PlanLevel, string>>>({});
  const prompt = dismissed === periods.day ? null : nextPrompt(periods, items);
  const rows = chain(periods, items, directions, teamGoals, picked);
  const weekRow = rows.find((r) => r.kind === 'week');
  const weekTasks = tasks.filter(
    (x) =>
      (weekRow && x.planItemId === weekRow.id) ||
      (!weekRow && x.assignee === me && x.status !== 'done'),
  );
  const cycle = (level: PlanLevel, current: string) => {
    const all = items.filter((i) => i.mine && i.level === level && i.period === periods[level]);
    const idx = all.findIndex((i) => i.id === current);
    const next = all[(idx + 1) % all.length];
    if (next) setPicked((p) => ({ ...p, [level]: next.id }));
  };
  return (
    <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        {suggestion}
        {prompt && (
          <PromptCard
            prompt={prompt}
            thisYear={periods.year}
            onGo={() =>
              prompt.kind === 'planYear' ? onPlanYear(prompt.year) : onBreakdown(prompt.parent.id)
            }
            onLater={() => {
              writeDismissed(periods.day);
              setDismissed(periods.day);
            }}
          />
        )}
        <Card padding="none" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-baseline gap-2.5 px-5 pt-4 pb-1.5">
            <h2 className="text-base font-bold">{t('guide.chain.title')}</h2>
            <span className="text-xs text-muted">{t('guide.chain.hint')}</span>
          </div>
          <div className="scroll-panel min-h-0 flex-1">
            {rows.length === 0 ? (
              <EmptyState>
                <span className="flex flex-col items-center gap-3">
                  {t('guide.chain.empty')}
                  <Button onClick={() => onPlanYear(periods.year)}>
                    {t('guide.planYear', { year: periods.year })}
                  </Button>
                </span>
              </EmptyState>
            ) : (
              rows.map((r) => {
                const item = items.find((i) => i.id === r.id);
                const level = r.kind as PlanLevel;
                return (
                  <div
                    key={r.kind}
                    className={`grid grid-cols-[96px_minmax(0,1fr)_120px] items-center gap-4 border-t border-line px-5 py-3 first:border-t-0 ${r.kind === 'direction' || r.kind === 'teamGoal' ? 'bg-bg' : ''}`}
                  >
                    <span className={`text-sm font-bold ${ROW_TEXT[r.kind]}`}>
                      {t(`guide.row.${r.kind}` as MessageKey)}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {item ? (
                        <LinkButton
                          className="self-start truncate text-left text-base font-semibold"
                          onClick={() => onEdit(item)}
                        >
                          {r.title}
                        </LinkButton>
                      ) : (
                        <span className="truncate text-base font-semibold">{r.title}</span>
                      )}
                      <span className="truncate text-xs text-muted">
                        {r.kind === 'week'
                          ? t('guide.row.weekTasks', {
                              done: weekTasks.filter((x) => x.status === 'done').length,
                              total: weekTasks.length,
                            })
                          : r.forTitle
                            ? t('guide.forTitle', { title: r.forTitle })
                            : r.kind === 'direction'
                              ? t('guide.row.directionHint')
                              : ''}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm font-bold">{Math.round(r.progress)}%</span>
                      <ProgressBar
                        value={r.progress / 100}
                        size="sm"
                        className="w-30"
                        barClassName={ROW_BG[r.kind]}
                        label={r.title}
                      />
                      {r.alternatives > 1 && (
                        <LinkButton className="text-xs" onClick={() => cycle(level, r.id)}>
                          {t('guide.row.switch', { n: r.alternatives })}
                        </LinkButton>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex gap-4 border-t border-line px-5 py-3 text-sm">
            <LinkButton onClick={onAll}>{t('guide.allGoals')}</LinkButton>
            <span className="ml-auto text-xs text-muted">{t('guide.advancedHint')}</span>
          </div>
        </Card>
      </section>
      <Card className="flex w-70 shrink-0 flex-col gap-2.5 wide:w-85">
        {direction}
        <div className="flex items-center border-t border-line pt-3">
          <h2 className="text-base font-bold">{t('guide.week.title')}</h2>
          <LinkButton className="ml-auto text-sm" onClick={onWeek}>
            {t('guide.week.all')}
          </LinkButton>
        </div>
        {weekRow && (
          <p className="text-xs text-muted">{t('guide.forTitle', { title: weekRow.title })}</p>
        )}
        <div className="scroll-panel flex min-h-0 flex-1 flex-col">
          {weekTasks.length === 0 ? (
            <EmptyState>{t('guide.week.empty')}</EmptyState>
          ) : (
            weekTasks.map((x) => <CheckRow key={x.id} task={x} members={members} me={me} compact />)
          )}
        </div>
      </Card>
    </div>
  );
}

// ── 你的方向（D6）與收到的建議 ─────────────────────────────────

const SUGGEST_DISMISS_KEY = 'hills.goals.suggestDismissed';

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(-100)));
  } catch {
    // 忽略
  }
}

function YourDirection({
  weeks,
  rules,
  periods,
  now,
  me,
  teamName,
  onWeekly,
}: {
  weeks: DirectionWeek[];
  rules: DirectionRules;
  periods: Periods;
  now: number;
  me: MemberView | null;
  teamName: string;
  onWeekly: () => void;
}) {
  const a = assess(weeks, rules, periods, now);
  const today = quarterElapsed(periods) * 100;
  // 第三欄 = 沒有資料可判定（本週沒有完成的事），顯示中性記號而不是 ✓（ui-spec v0.24）
  const checks: [boolean, string, boolean][] = [
    [!a.unaligned, a.unaligned ? t('drift.reason.unaligned') : t('drift.check.aligned'), false],
    a.share === null
      ? [true, t('drift.check.noUnits'), true]
      : [!a.elsewhere, a.elsewhere ? t('drift.reason.elsewhere') : t('drift.check.focused'), false],
    [!a.behind, a.behind ? t('drift.reason.behind') : t('drift.check.onPace'), false],
    [!a.stale, a.stale ? t('drift.reason.stale') : t('drift.check.fresh'), false],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-bold">{t('drift.mine.yours')}</h2>
        <StatePill state={a.state} />
        <LinkButton className="ml-auto text-xs" onClick={onWeekly}>
          {t('weekly.open')}
        </LinkButton>
      </div>
      {a.week && me ? (
        <>
          <div className="flex justify-center">
            <DirectionCompass
              mode="me"
              width={240}
              height={150}
              radius={92}
              today={today}
              teamLabel={teamName}
              people={[
                {
                  id: me.id,
                  name: me.name,
                  look: lookOf(me),
                  angle: a.angle,
                  progress: a.progress,
                  state: a.state === 'unknown' ? 'stale' : a.state,
                  unaligned: a.unaligned,
                  isMe: true,
                  side: sideOf(me.id),
                },
              ]}
              label={t('drift.compass.mine')}
            />
          </div>
          <MySentence a={a} today={today} />
          <ul className="flex flex-col gap-0.5 text-xs">
            {checks.map(([ok, text, neutral]) => (
              <li key={text} className={`flex gap-2 ${neutral ? 'text-muted' : ''}`}>
                <span
                  aria-hidden="true"
                  className={
                    neutral
                      ? 'w-2.5 text-center'
                      : ok
                        ? 'font-bold text-st-online-text'
                        : 'text-warning'
                  }
                >
                  {neutral ? '·' : ok ? '✓' : '▲'}
                </span>
                {text}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted">{t('drift.mine.empty')}</p>
      )}
    </div>
  );
}

function SuggestionCard({
  suggestions,
  items,
  members,
  teamGoals,
  directions,
  notify,
  onApplied,
}: {
  suggestions: SuggestionView[];
  items: PlanView[];
  members: MemberView[];
  teamGoals: TeamGoal[];
  directions: Direction[];
  notify: (s: ToastState) => void;
  onApplied: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => readList(SUGGEST_DISMISS_KEY));
  const { busy, error, attempt } = useAction();
  const s = suggestions.find((x) => {
    if (dismissed.includes(x.id)) return false;
    const item = items.find((i) => i.id === x.planItemId && i.mine);
    return item && item.alignedGoalId !== x.goalId;
  });
  if (!s) return null;
  const item = items.find((i) => i.id === s.planItemId);
  const goal =
    teamGoals.find((g) => g.id === s.goalId) ?? directions.find((d) => d.id === s.goalId);
  if (!item || !goal) return null;
  const from = members.find((m) => m.id === s.from)?.name ?? '';
  const dismiss = () => {
    const next = [...dismissed, s.id];
    writeList(SUGGEST_DISMISS_KEY, next);
    setDismissed(next);
  };
  const save = (alignedGoalId: string | null) =>
    api.savePlan({
      id: item.id,
      level: item.level,
      period: item.period,
      title: item.title,
      parentId: item.parentId,
      krRef: item.krRef,
      done: item.done,
      progressOverride: item.progressOverride,
      keyResults: item.keyResults,
      alignedGoalId,
      criteria: item.criteria,
      helps: item.helps,
      visibility: item.visibility,
    });
  return (
    <Card className="flex items-center gap-4 border border-warning shadow-none">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base font-bold">
          {t('drift.suggest.received', { name: from, plan: item.title, goal: goal.title })}
        </span>
        <span className="text-sm text-muted">{t('drift.suggest.receivedHint')}</span>
        <ErrorText message={error} />
      </div>
      <Button
        busy={busy}
        onClick={async () => {
          const prev = item.alignedGoalId;
          if (await attempt(() => save(s.goalId))) {
            dismiss();
            onApplied();
            notify({ message: t('drift.suggest.applied'), undo: () => save(prev) });
          }
        }}
      >
        {t('drift.suggest.apply')}
      </Button>
      <Button variant="ghost" onClick={dismiss}>
        {t('drift.suggest.dismiss')}
      </Button>
    </Card>
  );
}

function PromptCard({
  prompt,
  thisYear,
  onGo,
  onLater,
}: {
  prompt: Prompt;
  thisYear: string;
  onGo: () => void;
  onLater: () => void;
}) {
  const [title, body, go] = promptText(prompt, thisYear);
  return (
    <Card className="flex items-center gap-5 bg-primary-soft shadow-none">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
        <path d="M4 40 L18 16 L26 28 L32 20 L44 40 Z" className="fill-hill-near" />
        <circle cx="36" cy="12" r="5" className="fill-level-week" />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base font-bold">{title}</span>
        <span className="text-sm text-muted">{body}</span>
      </div>
      <Button onClick={onGo}>{go}</Button>
      <Button variant="ghost" onClick={onLater}>
        {t('guide.later')}
      </Button>
    </Card>
  );
}

function promptText(p: Prompt, thisYear: string): [string, string, string] {
  if (p.kind === 'planYear' && p.year === thisYear) {
    return [
      t('guide.prompt.thisYear.title', { year: p.year }),
      t('guide.prompt.thisYear.body'),
      t('guide.planYear', { year: p.year }),
    ];
  }
  if (p.kind === 'planYear') {
    return [
      t('guide.prompt.year.title', { year: p.year }),
      t('guide.prompt.year.body'),
      t('guide.planYear', { year: p.year }),
    ];
  }
  const level = p.parent.level;
  const key = level === 'year' ? 'quarter' : level === 'quarter' ? 'month' : 'week';
  return [
    t(`guide.prompt.${key}.title` as MessageKey, { title: p.parent.title }),
    t(`guide.prompt.${key}.body` as MessageKey, { title: p.parent.title }),
    t('guide.prompt.go'),
  ];
}

/** 一件任務的勾選列：勾選即標示完成（整筆更新任務狀態）。 */
function CheckRow({
  task,
  members,
  me,
  compact = false,
}: {
  task: Task;
  members: MemberView[];
  me: string;
  compact?: boolean;
}) {
  const { busy, error, attempt } = useAction();
  const owner =
    task.assignee && task.assignee !== me ? members.find((m) => m.id === task.assignee) : null;
  const done = task.status === 'done';
  const stepsDone = task.steps.filter((s) => s.done).length;
  return (
    <div
      className={`flex items-center gap-3 ${compact ? 'py-1.5' : 'border-t border-line px-5 py-3.5'}`}
    >
      <Checkbox
        aria-label={t('guide.week.markDone', { title: task.title })}
        checked={done}
        disabled={busy}
        onChange={(e) =>
          void attempt(() =>
            api.updateTask(
              task.team,
              task.id,
              taskInput(task, { status: e.target.checked ? 'done' : 'todo' }),
            ),
          )
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate ${done ? 'text-muted line-through' : 'font-semibold'}`}>
          {task.title}
          {isPrivateTask(task) && (
            <span className="ml-1.5 text-xs font-normal text-muted">{t('tasks.private')}</span>
          )}
          {owner && (
            <Badge
              className="ml-1.5 align-middle"
              label={t('guide.week.owner', { name: owner.name })}
            >
              {owner.name}
            </Badge>
          )}
        </span>
        {!compact && task.steps.length > 0 && !done && (
          <span className="text-xs text-muted">
            {t('guide.week.steps', { total: task.steps.length, done: stepsDone })}
          </span>
        )}
        <ErrorText message={error} />
      </div>
      {task.dueAt && !done && (
        <span className="shrink-0 text-xs text-muted">
          {new Date(task.dueAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
        </span>
      )}
    </div>
  );
}

// ── 這一週 ─────────────────────────────────────────────────

function WeekView({
  periods,
  now,
  items,
  tasks,
  teams,
  members,
  me,
  onBack,
  notify,
}: {
  periods: Periods;
  now: number;
  items: PlanView[];
  tasks: Task[];
  teams: GoalsProps['teams'];
  members: GoalsProps['members'];
  me: string;
  onBack: () => void;
  notify: (s: ToastState) => void;
}) {
  const [offset, setOffset] = useState(0);
  const week = offset === 0 ? periods.week : periodsAt(now + offset * WEEK_MS, '').week;
  const weekGoals = items.filter((i) => i.mine && i.level === 'week' && i.period === week);
  const [goalId, setGoalId] = useState<string | null>(null);
  const goal = weekGoals.find((g) => g.id === goalId) ?? weekGoals[0] ?? null;
  const list = goal ? tasks.filter((x) => x.planItemId === goal.id) : [];
  const done = list.filter((x) => x.status === 'done').length;
  const loose = tasks.filter(
    (x) => !x.planItemId && x.assignee === me && x.status !== 'done' && !isPrivateTask(x),
  );
  const { year, n } = splitPeriod('week', week);
  const range = weekRange(year, n);
  const levelRows = (['week', 'month', 'quarter', 'year'] as PlanLevel[]).map((level) => {
    const it = items.find((i) => i.mine && i.level === level && i.period === periods[level]);
    return { level, progress: it?.progress ?? 0, has: Boolean(it) };
  });
  const { attempt, error } = useAction();
  return (
    <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 text-sm">
          <LinkButton onClick={onBack}>{t('guide.back')}</LinkButton>
          <span className="ml-auto flex items-center gap-1.5">
            <IconButton
              variant="secondary"
              size="sm"
              label={t('guide.week.prev')}
              onClick={() => setOffset((o) => o - 1)}
            >
              ◀
            </IconButton>
            <span className="min-w-30 text-center font-bold">
              {`${range.start.m}/${range.start.d} – ${range.end.m}/${range.end.d}`}
            </span>
            <IconButton
              variant="secondary"
              size="sm"
              label={t('guide.week.next')}
              onClick={() => setOffset((o) => o + 1)}
            >
              ▶
            </IconButton>
          </span>
        </div>
        <Card padding="none" className="flex min-h-0 flex-1 flex-col">
          {goal ? (
            <>
              <div className="flex items-center gap-4 px-5 pt-4 pb-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-sm text-muted">{t('guide.week.goal')}</span>
                  {weekGoals.length > 1 ? (
                    <SegmentedControl
                      label={t('guide.week.goal')}
                      options={weekGoals.map((g) => ({ value: g.id, label: g.title }))}
                      value={goal.id}
                      onChange={setGoalId}
                      className="self-start"
                    />
                  ) : (
                    <span className="truncate text-lg font-bold">{goal.title}</span>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-sm">
                    {t('guide.week.doneCount', { done, total: list.length })}
                  </span>
                  <ProgressBar
                    value={goal.progress / 100}
                    className="w-45"
                    barClassName="bg-level-week"
                    label={goal.title}
                  />
                </div>
              </div>
              <div className="scroll-panel min-h-0 flex-1">
                {list.map((x) => (
                  <CheckRow key={x.id} task={x} members={members} me={me} />
                ))}
                <AddTask
                  goal={goal}
                  teams={teams}
                  members={members}
                  tasks={tasks}
                  me={me}
                  notify={notify}
                />
              </div>
            </>
          ) : (
            <EmptyState>{t('guide.week.noGoal')}</EmptyState>
          )}
          {goal && loose.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3 text-sm">
              <span className="text-muted">{t('guide.week.loose', { n: loose.length })}</span>
              <span>{loose[0]?.title}</span>
              <LinkButton
                onClick={() => {
                  const x = loose[0];
                  if (x)
                    void attempt(() =>
                      api.updateTask(x.team, x.id, taskInput(x, { planItemId: goal.id })),
                    );
                }}
              >
                {t('guide.week.link')}
              </LinkButton>
              <ErrorText message={error} />
            </div>
          )}
        </Card>
      </section>
      <Card className="flex w-70 shrink-0 flex-col gap-3.5 wide:w-85">
        <h2 className="text-base font-bold">{t('guide.push.title')}</h2>
        <p className="text-sm leading-normal text-muted">{t('guide.push.body')}</p>
        {levelRows.map((r) => (
          <div
            key={r.level}
            className="grid grid-cols-[72px_minmax(0,1fr)_44px] items-center gap-2.5 text-sm"
          >
            <span className={`font-bold ${ROW_TEXT[r.level]}`}>
              {t(`guide.row.${r.level}` as MessageKey)}
            </span>
            <ProgressBar
              value={r.progress / 100}
              barClassName={ROW_BG[r.level]}
              size="sm"
              label={t(`guide.row.${r.level}` as MessageKey)}
            />
            <span className="text-right text-xs font-bold">
              {r.has ? `${Math.round(r.progress)}%` : '—'}
            </span>
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-1.5 rounded-control bg-bg px-3.5 py-3">
          <span className="text-sm font-bold">{t('guide.push.monday')}</span>
          <span className="text-sm leading-normal text-muted">{t('guide.push.mondayBody')}</span>
        </div>
      </Card>
    </div>
  );
}

/** 清單最後一列：打字按 Enter 就建立任務並連到這個週目標（選填期限、負責人、私人）。 */
function AddTask({
  goal,
  teams,
  members,
  tasks,
  me,
  notify,
}: {
  goal: PlanView;
  teams: GoalsProps['teams'];
  members: GoalsProps['members'];
  tasks: Task[];
  me: string;
  notify: (s: ToastState) => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState(me);
  const [priv, setPriv] = useState(false);
  const [open, setOpen] = useState<'due' | 'who' | null>(null);
  const { busy, error, run } = useAction();
  const team = priv ? PRIVATE_TEAM : (teams[0]?.id ?? PRIVATE_TEAM);
  const submit = async () => {
    const text = title.trim();
    if (!text) return;
    const id = await run(() =>
      api.createTask(team, {
        title: text,
        assignee: team === PRIVATE_TEAM ? me : assignee || null,
        dueAt: due ? new Date(`${due}T18:00`).getTime() : null,
        steps: [],
        planItemId: goal.id,
      }),
    );
    if (!id) return;
    setTitle('');
    setDue('');
    setAssignee(me);
    setOpen(null);
    notify({
      message: t('guide.week.added', { title: text }),
      undo: () => api.deleteTask(team, id),
    });
  };
  return (
    <div className="flex flex-col gap-2 border-t border-line bg-bg px-5 pt-3.5 pb-3.5">
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="size-5.5 shrink-0 rounded-md border-2 border-dashed border-muted"
        />
        <TextInput
          className="flex-1"
          aria-label={t('guide.week.addLabel')}
          placeholder={t('guide.week.addPlaceholder')}
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-9">
        <Chip
          selected={Boolean(due) || open === 'due'}
          onClick={() => setOpen(open === 'due' ? null : 'due')}
        >
          {due ? `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}` : t('guide.week.when')}
        </Chip>
        {!priv && (
          <Chip
            selected={assignee !== me || open === 'who'}
            onClick={() => setOpen(open === 'who' ? null : 'who')}
          >
            {assignee !== me
              ? (members.find((m) => m.id === assignee)?.name ?? t('guide.week.who'))
              : t('guide.week.who')}
          </Chip>
        )}
        <Chip selected={priv} onClick={() => setPriv((p) => !p)}>
          {t('guide.week.private')}
        </Chip>
        {open === 'due' && (
          <TextInput
            type="date"
            size="sm"
            aria-label={t('guide.week.when')}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        )}
        {open === 'who' && !priv && (
          <Select
            aria-label={t('guide.week.who')}
            className="w-60"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {whoLabel(m, openCount(tasks, m.id))}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto text-xs text-muted">{t('guide.week.addHint')}</span>
      </div>
      <ErrorText message={error} />
    </div>
  );
}

/** 負責人選單的選項文字：名字 · 休假至 / 離線 · N 件進行中（ui-spec「這一週」v0.24）。 */
function whoLabel(m: MemberView, open: number): string {
  const parts = [m.isMe ? t('goals.owner.me') : m.name];
  if (m.presence === 'Leave') {
    parts.push(
      m.until
        ? t('home.leaveUntil', {
            date: new Date(m.until).toLocaleDateString(undefined, {
              month: 'numeric',
              day: 'numeric',
            }),
          })
        : t('presence.Leave'),
    );
  } else if (m.presence === 'Offline' || m.presence === null) {
    parts.push(t('presence.Offline'));
  }
  if (open > 0) parts.push(t('guide.week.openCount', { n: open }));
  return parts.join(' · ');
}
