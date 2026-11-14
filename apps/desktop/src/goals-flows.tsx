/**
 * 目標的四個引導流程（ui-spec「工作 › 目標的引導流程」v0.46，D67；設計畫布 G1–G4）：
 * 規劃新的一期、拆到下一層、調整目標、期末回顧。每一步只問一個問題；上一層由流程帶入。
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type PlanInput,
  type PlanLevel,
  type PlanView,
  type ReviewOutcome,
  type Task,
  type TeamView,
} from './api';
import { toInput } from './goals-editor';
import {
  carryInput,
  firstDay,
  newPlanInput,
  parentChoices,
  periodOptions,
  reviewCounts,
  shiftPeriod,
  suggestChildren,
  titleSuggestions,
  weekCapacity,
  withReview,
  type ChildDraft,
  type DoneRule,
  type ReviewWindow,
} from './goals-flow-utils';
import { taskInput, type ToastState } from './goals-guided';
import type { Periods } from './goals-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import type { PeriodKind } from './report-utils';
import { periodLabel } from './report-view';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChoiceCard,
  Dialog,
  DialogFooter,
  ErrorText,
  LinkButton,
  OptionTile,
  ProgressBar,
  Select,
  Slider,
  Stepper,
  TextArea,
  TextInput,
  useAction,
} from './ui';
import { hm } from './work-utils';

const KIND: Record<PlanLevel, PeriodKind> = {
  year: 'yearly',
  quarter: 'quarterly',
  month: 'monthly',
  week: 'weekly',
  day: 'daily',
};

/** 期間的顯示寫法（2026 Q4、2026 年 12 月、12/07 – 12/13 · W50）。 */
export const planPeriod = (level: PlanLevel, period: string) => periodLabel(KIND[level], period);
const levelName = (l: PlanLevel) => t(`goals.level.${l}` as MessageKey);

export interface FlowShared {
  items: PlanView[];
  tasks: Task[];
  me: string;
  myTeams: TeamView[];
  timezone: string;
  periods: Periods;
  onCancel: () => void;
  onDone: (s: ToastState) => void;
}

// ── 草稿（本機，「之後再繼續」）──────────────────────────────

function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function useDraft<T>(key: string, initial: () => T, accept: (d: T) => boolean = () => true) {
  const [state, setState] = useState<T>(() => {
    const d = readDraft<T>(key);
    return d && accept(d) ? d : initial();
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // 無法保存草稿時只影響「之後再繼續」
    }
  }, [key, state]);
  const clear = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // 同上
    }
  };
  return [state, setState, clear] as const;
}

// ── 共用版面 ───────────────────────────────────────────────

function FlowFrame({
  name,
  steps,
  details,
  current,
  aside,
  children,
  onBack,
  next,
  onExit,
  onLater,
  error,
}: {
  name: string;
  steps: string[];
  details?: (string | undefined)[];
  current: number;
  aside: ReactNode;
  children: ReactNode;
  onBack: (() => void) | null;
  next: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean };
  onExit: () => void;
  onLater: () => void;
  error?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead title={t('goals.title')} />
      <div className="flex items-center gap-3">
        <LinkButton className="text-sm" onClick={onExit}>
          ‹ {t('flow.backToGoals')}
        </LinkButton>
        <span className="ml-auto text-xs text-muted">{t('flow.draftHint')}</span>
        <Button size="sm" variant="secondary" onClick={onLater}>
          {t('flow.later')}
        </Button>
      </div>
      <Card
        padding="none"
        className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_300px] wide:grid-cols-[240px_minmax(0,1fr)_340px]"
      >
        <div className="flex flex-col gap-2 border-r border-line p-4">
          <span className="px-2.5 text-xs font-bold text-muted">
            {t('flow.stepOf', { name, n: current + 1, total: steps.length })}
          </span>
          <Stepper
            label={t('guide.steps')}
            steps={steps}
            current={current}
            details={details}
            vertical
          />
        </div>
        <form
          className="scroll-panel flex min-h-0 min-w-0 flex-col gap-4 px-8 py-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!next.disabled && !next.busy) next.onClick();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onLater();
          }}
        >
          {children}
          <ErrorText message={error ?? null} />
          <div className="mt-auto flex items-center gap-2 border-t border-line pt-4">
            {onBack && (
              <Button variant="secondary" onClick={onBack}>
                ‹ {t('flow.prev')}
              </Button>
            )}
            <span className="ml-auto text-xs text-muted">{t('flow.keys')}</span>
            <Button type="submit" busy={next.busy} disabled={next.disabled}>
              {next.label}
            </Button>
          </div>
        </form>
        <aside className="scroll-panel flex min-h-0 flex-col gap-3 rounded-r-card border-l border-line bg-bg p-5">
          {aside}
        </aside>
      </Card>
    </div>
  );
}

function Question({ title, help }: { title: string; help?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-lg font-bold">{title}</h2>
      {help && <p className="text-sm text-muted">{help}</p>}
    </div>
  );
}

function AsideHead({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-bold text-muted">{children}</h3>;
}

/** 右欄的目標卡：期間、名稱、進度、關鍵結果。 */
function GoalBox({ item, krs = false }: { item: PlanView; krs?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-line bg-surface p-3">
      <Badge className="self-start">{planPeriod(item.level, item.period)}</Badge>
      <span className="text-sm font-bold">{item.title}</span>
      <span className="flex items-center gap-2">
        <ProgressBar size="sm" className="flex-1" value={item.progress / 100} label={item.title} />
        <span className="text-xs">{Math.round(item.progress)}%</span>
      </span>
      {krs &&
        item.keyResults.map((k) => {
          const v = item.krProgress[k.id] ?? 0;
          return (
            <span key={k.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{k.title}</span>
              <span className="text-muted">
                {k.current} / {k.target} {k.unit}
              </span>
              <span className="w-9 text-right">{Math.round(v)}%</span>
            </span>
          );
        })}
    </div>
  );
}

const visibilityOf = (myTeams: TeamView[], priv: boolean, parent: PlanView | null) =>
  priv
    ? ({ kind: 'private' } as const)
    : (parent?.visibility ??
      (myTeams[0] ? ({ kind: 'team', team: myTeams[0].id } as const) : ({ kind: 'org' } as const)));

// ── ① 規劃新的一期（G1）─────────────────────────────────────

interface PlanDraft {
  step: number;
  level: PlanLevel;
  period: string;
  parentId: string;
  title: string;
  krRef: string | null;
  rule: DoneRule;
  target: string;
  unit: string;
  priv: boolean;
  thenBreakdown: boolean;
}

const PLAN_STEPS = ['period', 'parent', 'title', 'rule', 'confirm'] as const;
const NONE = '__none';

export function PlanPeriodFlow({
  items,
  myTeams,
  periods,
  initial,
  onCancel,
  onDone,
  onPlanYear,
  onBreakdown,
}: FlowShared & {
  initial?: { level: PlanLevel; period: string };
  onPlanYear: (year: string) => void;
  onBreakdown: (parentId: string) => void;
}) {
  const options = periodOptions(periods, items);
  const first = options.find((o) => o.empty) ?? options[0]!;
  const [d, setD, clear] = useDraft<PlanDraft>(
    'hills.flow.plan',
    () => ({
      step: initial ? 1 : 0,
      level: initial?.level ?? first.level,
      period: initial?.period ?? first.period,
      parentId: '',
      title: '',
      krRef: null,
      rule: 'tasks',
      target: '',
      unit: '',
      priv: false,
      thenBreakdown: true,
    }),
    (x) => !initial || (x.level === initial.level && x.period === initial.period),
  );
  const set = (p: Partial<PlanDraft>) => setD((x) => ({ ...x, ...p }));
  const { busy, error, run } = useAction();
  const [titleError, setTitleError] = useState<string | null>(null);
  const parents = parentChoices(items, d.level, d.period);
  const parentId = d.parentId || parents[0]?.id || NONE;
  const parent = items.find((p) => p.id === parentId) ?? null;
  const suggestions = titleSuggestions(items, parent, d.level, d.period);
  const label = planPeriod(d.level, d.period);
  const key = PLAN_STEPS[d.step]!;
  const exit = () => {
    clear();
    onCancel();
  };
  const create = () =>
    void run(async () => {
      const input = newPlanInput({
        level: d.level,
        period: d.period,
        title: d.title,
        parent,
        krRef: d.krRef,
        rule: d.rule,
        target: Number(d.target) || 0,
        unit: d.unit,
        visibility: visibilityOf(myTeams, d.priv, parent),
      });
      const id = await api.savePlan(input);
      clear();
      onDone({ message: t('flow.plan.done', { period: label }) });
      if (d.thenBreakdown && d.level !== 'week') onBreakdown(id);
    });
  const next = () => {
    if (key === 'title' && !d.title.trim()) {
      setTitleError(t('field.required'));
      return;
    }
    if (key === 'rule' && d.rule === 'number' && !(Number(d.target) > 0)) return;
    if (key === 'confirm') return create();
    set({ step: d.step + 1, ...(key === 'parent' ? { parentId } : {}) });
  };
  const ruleText = {
    tasks: t('flow.rule.tasks'),
    number: t('flow.rule.numberDone', { n: d.target || '0', unit: d.unit }),
    self: t('flow.rule.self'),
  }[d.rule];
  const checks = [
    { ok: d.title.trim().length > 0 && d.title.trim().length <= 60, text: t('flow.check.short') },
    { ok: /\d|完成|上線|達到|交付|發佈|驗收/.test(d.title), text: t('flow.check.measurable') },
  ];
  return (
    <FlowFrame
      name={t('flow.plan.name', { period: label })}
      steps={PLAN_STEPS.map((k) => t(`flow.plan.step.${k}` as MessageKey))}
      details={[label, parent?.title ?? t('flow.plan.noParent'), d.title, ruleText]}
      current={d.step}
      onBack={d.step > 0 ? () => set({ step: d.step - 1 }) : null}
      next={{
        label:
          key === 'confirm'
            ? t('flow.plan.create', { period: label })
            : t('flow.next', {
                step: t(`flow.plan.step.${PLAN_STEPS[d.step + 1]}` as MessageKey),
              }),
        onClick: next,
        busy,
        disabled: key === 'rule' && d.rule === 'number' && !(Number(d.target) > 0),
      }}
      onExit={exit}
      onLater={onCancel}
      error={error}
      aside={
        <>
          <AsideHead>{t('flow.aside.parent')}</AsideHead>
          {parent ? (
            <GoalBox item={parent} krs />
          ) : (
            <p className="text-sm text-muted">{t('flow.aside.noParent')}</p>
          )}
          {suggestions.some((s) => s.kind === 'carry') && (
            <>
              <AsideHead>{t('flow.aside.prev')}</AsideHead>
              {suggestions
                .filter((s) => s.kind === 'carry')
                .map((s) => (
                  <p key={s.ref} className="text-sm">
                    {s.title} <span className="text-xs text-muted">· {s.note}</span>
                  </p>
                ))}
            </>
          )}
        </>
      }
    >
      {key === 'period' && (
        <>
          <Question title={t('flow.plan.q.period')} help={t('flow.plan.h.period')} />
          <OptionTile
            label={t('flow.plan.q.period')}
            columns={2}
            value={`${d.level}|${d.period}`}
            onChange={(v) => {
              const [level, period] = v.split('|') as [PlanLevel, string];
              set({ level, period, parentId: '', krRef: null });
            }}
            options={options.map((o) => ({
              value: `${o.level}|${o.period}`,
              title: `${levelName(o.level)} · ${planPeriod(o.level, o.period)}`,
              description: o.empty ? t('flow.plan.empty') : t('flow.plan.hasGoal'),
            }))}
          />
          <LinkButton className="self-start text-sm" onClick={() => onPlanYear(periods.year)}>
            {t('flow.plan.year')}
          </LinkButton>
        </>
      )}
      {key === 'parent' && (
        <>
          <Question
            title={t('flow.plan.q.parent')}
            help={t('flow.plan.h.parent', { level: levelName(d.level) })}
          />
          <ChoiceCard
            label={t('flow.plan.q.parent')}
            value={parentId}
            onChange={(v) => set({ parentId: v, krRef: null })}
            options={[
              ...parents.map((p) => ({
                value: p.id,
                title: p.title,
                description: `${planPeriod(p.level, p.period)} · ${Math.round(p.progress)}%`,
              })),
              { value: NONE, title: t('flow.plan.personal'), dashed: true },
            ]}
          />
        </>
      )}
      {key === 'title' && (
        <>
          <Question
            title={t('flow.plan.q.title', { period: label })}
            help={t('flow.plan.h.title')}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-bold">
              {t('flow.plan.titleLabel', { period: label })}
            </span>
            <TextArea
              autoFocus
              rows={3}
              maxLength={200}
              value={d.title}
              onChange={(e) => {
                set({ title: e.target.value });
                setTitleError(null);
              }}
            />
          </label>
          <ErrorText message={titleError} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {checks.map((c) => (
              <span key={c.text} className={c.ok ? 'text-st-online-text' : 'text-muted'}>
                {c.ok ? '✓' : '·'} {c.text}
              </span>
            ))}
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-bold">{t('flow.plan.suggest')}</span>
              {suggestions.map((s) => (
                <div
                  key={s.ref}
                  className="flex items-center gap-3 rounded-control border border-line px-3 py-2 text-sm"
                >
                  <Badge>{t(`flow.plan.sug.${s.kind}` as MessageKey)}</Badge>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="text-xs text-muted">{s.note}</span>
                  <LinkButton
                    className="text-sm"
                    onClick={() =>
                      set({ title: s.title, krRef: s.kind === 'kr' ? s.ref : d.krRef })
                    }
                  >
                    {t('flow.plan.use')}
                  </LinkButton>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {key === 'rule' && (
        <>
          <Question title={t('flow.plan.q.rule')} help={t('flow.plan.h.rule')} />
          <ChoiceCard<DoneRule>
            label={t('flow.plan.q.rule')}
            value={d.rule}
            onChange={(rule) => set({ rule })}
            options={[
              {
                value: 'tasks',
                title: t('flow.rule.tasks'),
                description: t('flow.rule.tasksHint'),
              },
              {
                value: 'number',
                title: t('flow.rule.number'),
                description: t('flow.rule.numberHint'),
              },
              { value: 'self', title: t('flow.rule.self'), description: t('flow.rule.selfHint') },
            ]}
          />
          {d.rule === 'number' && (
            <div className="flex items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">{t('flow.rule.target')}</span>
                <TextInput
                  type="number"
                  min={1}
                  className="w-32"
                  value={d.target}
                  onChange={(e) => set({ target: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">{t('flow.rule.unit')}</span>
                <TextInput
                  className="w-28"
                  maxLength={16}
                  value={d.unit}
                  onChange={(e) => set({ unit: e.target.value })}
                />
              </label>
            </div>
          )}
        </>
      )}
      {key === 'confirm' && (
        <>
          <Question title={t('flow.confirm')} />
          <div className="flex flex-col gap-2 rounded-control bg-bg p-4 text-sm">
            <span>
              {parent ? `${parent.title} → ` : ''}
              <strong>{label}</strong>：{d.title.trim()}
            </span>
            <span className="text-muted">{t('flow.plan.ruleIs', { rule: ruleText })}</span>
          </div>
          <Checkbox
            label={t('flow.plan.private')}
            checked={d.priv}
            onChange={(e) => set({ priv: e.target.checked })}
          />
          {d.level !== 'week' && (
            <Checkbox
              label={t('flow.plan.thenBreakdown')}
              checked={d.thenBreakdown}
              onChange={(e) => set({ thenBreakdown: e.target.checked })}
            />
          )}
        </>
      )}
    </FlowFrame>
  );
}

// ── ② 拆到下一層（G2）──────────────────────────────────────

const CHILD: Partial<Record<PlanLevel, PlanLevel>> = {
  year: 'quarter',
  quarter: 'month',
  month: 'week',
};

export function BreakdownFlow({
  items,
  tasks,
  me,
  periods,
  timezone,
  parent: initialParent,
  onCancel,
  onDone,
}: FlowShared & { parent: PlanView | null }) {
  const RANK: Partial<Record<PlanLevel, number>> = { month: 0, quarter: 1, year: 2 };
  const kidsOf = (id: string) => items.filter((c) => c.parentId === id).length;
  const candidates = items
    .filter(
      (p) =>
        p.mine &&
        p.level !== 'week' &&
        !p.review &&
        !p.done &&
        p.period >=
          periods[p.level === 'year' ? 'year' : p.level === 'quarter' ? 'quarter' : 'month'],
    )
    // 還沒拆過的在前，再依月 → 季 → 年
    .sort(
      (a, b) =>
        Number(kidsOf(a.id) > 0) - Number(kidsOf(b.id) > 0) ||
        (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9),
    );
  const [step, setStep] = useState(initialParent ? 1 : 0);
  const [parentId, setParentId] = useState(initialParent?.id ?? candidates[0]?.id ?? '');
  const parent = items.find((p) => p.id === parentId) ?? null;
  const profile = useLoad(api.myProfile, ['doc']);
  const [rows, setRows] = useState<ChildDraft[] | null>(null);
  const { busy, error, run } = useAction();
  const draft =
    rows ?? (parent ? suggestChildren(parent, items, tasks, me, periods.day, timezone) : []);
  const child = parent ? CHILD[parent.level] : undefined;
  const chosen = draft.filter((r) => r.on && r.title.trim());
  const edit = (i: number, p: Partial<ChildDraft>) =>
    setRows(draft.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const create = () =>
    void run(async () => {
      if (!parent) return;
      for (const r of chosen) {
        const id = await api.savePlan({
          level: r.slot.level,
          period: r.slot.period,
          title: r.title.trim(),
          parentId: parent.id,
          krRef: null,
          done: false,
          progressOverride: null,
          keyResults: [],
          alignedGoalId: r.slot.level === 'quarter' ? parent.alignedGoalId : null,
          criteria: [],
          helps: [],
          review: null,
          visibility: parent.visibility,
        });
        if (r.slot.level === 'week') {
          for (const tid of r.tasks) {
            const task = tasks.find((x) => x.id === tid);
            if (task && !task.planItemId)
              await api.updateTask(task.team, task.id, taskInput(task, { planItemId: id }));
          }
        }
      }
      onDone({ message: t('flow.bd.done', { n: chosen.length }) });
    });
  const steps = ['pick', 'rows', 'confirm'].map((k) => t(`flow.bd.step.${k}` as MessageKey));
  const childName = child ? levelName(child) : '';
  return (
    <FlowFrame
      name={t('flow.bd.name', { level: childName })}
      steps={steps}
      details={[parent?.title, t('flow.bd.count', { n: chosen.length, level: childName })]}
      current={step}
      onBack={step > 0 ? () => setStep(step - 1) : null}
      next={{
        label:
          step === 2
            ? t('flow.bd.create', { n: chosen.length, level: childName })
            : t('flow.next', { step: steps[step + 1]! }),
        onClick: () => (step === 2 ? create() : setStep(step + 1)),
        busy,
        disabled: !parent || (step >= 1 && chosen.length === 0),
      }}
      onExit={onCancel}
      onLater={onCancel}
      error={error}
      aside={
        <>
          <AsideHead>{t('flow.bd.aside.goal')}</AsideHead>
          {parent ? <GoalBox item={parent} krs /> : null}
          {child === 'week' && (
            <>
              <AsideHead>{t('flow.bd.aside.capacity')}</AsideHead>
              {draft.map((r) => {
                const c = weekCapacity(r.slot.period, profile.data?.workHours);
                return (
                  <span key={r.slot.period} className="flex items-center gap-2 text-xs">
                    <span className="w-10">{r.slot.period.slice(5)}</span>
                    <ProgressBar
                      size="sm"
                      className="flex-1"
                      value={Math.min(1, c / 2400)}
                      label={r.slot.period}
                    />
                    <span className="w-12 text-right">{hm(c)}</span>
                  </span>
                );
              })}
              <span className="text-xs text-muted">{t('flow.bd.capacityHint')}</span>
            </>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <Question title={t('flow.bd.q.pick')} help={t('flow.bd.h.pick')} />
          {candidates.length === 0 ? (
            <p className="text-sm text-muted">{t('flow.bd.none')}</p>
          ) : (
            <ChoiceCard
              label={t('flow.bd.q.pick')}
              value={parentId || null}
              onChange={(v) => {
                setParentId(v);
                setRows(null);
              }}
              options={candidates.map((p) => {
                const n = items.filter((c) => c.parentId === p.id).length;
                return {
                  value: p.id,
                  title: p.title,
                  description: `${planPeriod(p.level, p.period)} · ${
                    n ? t('flow.bd.has', { n }) : t('flow.bd.notYet')
                  }`,
                  badge: n === 0 ? <Badge tone="primary">{t('flow.suggested')}</Badge> : undefined,
                };
              })}
            />
          )}
        </>
      )}
      {step === 1 && parent && (
        <>
          <Question
            title={t('flow.bd.q.rows', {
              period: planPeriod(parent.level, parent.period),
              level: childName,
            })}
            help={t('flow.bd.h.rows')}
          />
          <div className="flex flex-col gap-2">
            {draft.map((r, i) => {
              const name = planPeriod(r.slot.level, r.slot.period);
              return (
                <div
                  key={r.slot.period}
                  className={`grid grid-cols-[auto_150px_minmax(0,1fr)_auto] items-center gap-3 rounded-control border px-3 py-2 ${r.on ? 'border-line' : 'border-dashed border-line bg-bg'}`}
                >
                  <Checkbox
                    aria-label={t('flow.bd.include', { period: name })}
                    checked={r.on}
                    onChange={(e) => edit(i, { on: e.target.checked })}
                  />
                  <span className="text-sm font-semibold">{name}</span>
                  <TextInput
                    size="sm"
                    aria-label={t('flow.bd.rowLabel', { period: name })}
                    placeholder={t('flow.bd.placeholder')}
                    maxLength={200}
                    value={r.title}
                    onChange={(e) =>
                      edit(i, { title: e.target.value, on: r.on || Boolean(e.target.value.trim()) })
                    }
                  />
                  {r.tasks.length > 0 ? (
                    <Badge>{t('flow.bd.tasks', { n: r.tasks.length })}</Badge>
                  ) : child === 'week' ? (
                    <Badge>{hm(weekCapacity(r.slot.period, profile.data?.workHours))}</Badge>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
          <LinkButton
            className="self-start text-sm"
            onClick={() => setRows(draft.map((r) => ({ ...r, title: '', on: false })))}
          >
            {t('flow.bd.clear')}
          </LinkButton>
        </>
      )}
      {step === 2 && parent && (
        <>
          <Question title={t('flow.bd.q.confirm', { n: chosen.length, level: childName })} />
          <ul className="flex flex-col gap-1.5 rounded-control bg-bg p-4 text-sm">
            {chosen.map((r) => (
              <li key={r.slot.period}>
                <strong>{planPeriod(r.slot.level, r.slot.period)}</strong>：{r.title.trim()}
                {r.tasks.length > 0 && (
                  <span className="text-xs text-muted">
                    {' '}
                    · {t('flow.bd.tasks', { n: r.tasks.length })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t('flow.bd.forParent', { title: parent.title })}</p>
        </>
      )}
    </FlowFrame>
  );
}

// ── ③ 調整目標（G3）────────────────────────────────────────

type AdjustAction = 'period' | 'kr' | 'carry' | 'complete' | 'drop';
type CarryMode = 'move' | 'split' | 'merge';
type DropReason = 'direction' | 'merged' | 'other';

export function AdjustFlow({
  item: initialItem,
  items,
  tasks,
  onClose,
  onDone,
  onEditText,
}: {
  item: PlanView | null;
  items: PlanView[];
  tasks: Task[];
  onClose: () => void;
  onDone: (s: ToastState) => void;
  onEditText: (item: PlanView) => void;
}) {
  const mine = items.filter((p) => p.mine && !p.review);
  const [itemId, setItemId] = useState(
    initialItem?.id ?? mine.find((p) => p.level !== 'year')?.id ?? '',
  );
  const item = items.find((p) => p.id === itemId) ?? null;
  const [step, setStep] = useState(initialItem ? 1 : 0);
  const [action, setAction] = useState<AdjustAction>('period');
  const [period, setPeriod] = useState('');
  const [krRef, setKrRef] = useState<string>('');
  const [carry, setCarry] = useState<CarryMode>('split');
  const [mergeInto, setMergeInto] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  const [reason, setReason] = useState<DropReason>('direction');
  const [note, setNote] = useState('');
  const [moveDue, setMoveDue] = useState(true);
  const { busy, error, run } = useAction();
  if (!item && step > 0) return null;
  const parent = item ? (items.find((p) => p.id === item.parentId) ?? null) : null;
  const target = period || (item ? shiftPeriod(item.level, item.period, 1) : '');
  const nextPeriod = item ? shiftPeriod(item.level, item.period, 1) : '';
  const nextItems = item
    ? mine.filter((p) => p.level === item.level && p.period === nextPeriod && p.id !== item.id)
    : [];
  const linked = item ? tasks.filter((x) => x.planItemId === item.id) : [];
  const open = linked.filter((x) => x.status !== 'done');
  const pct = percent ?? Math.round(item?.progress ?? 0);
  const actionTitle = (a: AdjustAction) => t(`adjust.a.${a}` as MessageKey);
  const save = (input: PlanInput) => api.savePlan(input);
  const moveTasks = async (to: string) => {
    for (const x of open) await api.updateTask(x.team, x.id, taskInput(x, { planItemId: to }));
  };
  const shiftDue = async (from: string, to: string) => {
    if (!item) return;
    const ms =
      Date.parse(`${firstDay(item.level, to)}T00:00:00Z`) -
      Date.parse(`${firstDay(item.level, from)}T00:00:00Z`);
    for (const x of linked)
      if (x.dueAt !== null && x.status !== 'done')
        await api.updateTask(x.team, x.id, taskInput(x, { dueAt: x.dueAt + ms }));
  };
  const apply = () =>
    void run(async () => {
      if (!item) return;
      const base = toInput(item);
      let message: string;
      if (action === 'period') {
        await save({ ...base, period: target });
        if (moveDue) await shiftDue(item.period, target);
        message = t('adjust.done.period', { period: planPeriod(item.level, target) });
      } else if (action === 'kr') {
        await save({ ...base, krRef: krRef || null });
        message = t('adjust.done.kr');
      } else if (action === 'carry') {
        if (carry === 'move') {
          await save({ ...base, period: nextPeriod });
          if (moveDue) await shiftDue(item.period, nextPeriod);
        } else {
          const to = carry === 'merge' && mergeInto ? mergeInto : await save(carryInput(item));
          await moveTasks(to);
          await save(withReview(base, 'partial', item.progress, '', to));
        }
        message = t('adjust.done.carry', { period: planPeriod(item.level, nextPeriod) });
      } else if (action === 'complete') {
        await save(withReview(base, pct >= 100 ? 'achieved' : 'partial', pct, ''));
        message = t('adjust.done.complete', { title: item.title });
      } else {
        const why = t(`adjust.reason.${reason}` as MessageKey);
        await save(
          withReview(base, 'dropped', item.progress, note.trim() ? `${why}：${note.trim()}` : why),
        );
        message = t('adjust.done.drop', { title: item.title });
      }
      onDone({ message });
    });
  const periodTiles = item
    ? [-1, 0, 1, 2, 3, 4].map((n) => {
        const p = shiftPeriod(item.level, item.period, n);
        return {
          value: p,
          title: planPeriod(item.level, p),
          description: n === 0 ? t('adjust.now') : undefined,
          disabled: n === 0,
        };
      })
    : [];
  const krOptions = parent
    ? [
        ...parent.keyResults.map((k) => ({
          value: `${parent.id}/${k.id}`,
          title: k.title,
          description: `${Math.round(parent.krProgress[k.id] ?? 0)}%`,
        })),
        { value: '', title: t('adjust.kr.parentItself'), description: parent.title },
      ]
    : [];
  const steps = ['pick', 'what', 'one', 'confirm'];
  const canNext =
    step === 0
      ? Boolean(item)
      : step === 1
        ? !(action === 'kr' && krOptions.length <= 1)
        : step === 2
          ? !(action === 'carry' && carry === 'merge' && !mergeInto)
          : true;
  const impacts: string[] = !item
    ? []
    : action === 'period' || (action === 'carry' && carry === 'move')
      ? [
          t('adjust.impact.children', {
            n: items.filter((c) => c.parentId === item.id).length,
          }),
          t('adjust.impact.tasks', { n: linked.filter((x) => x.dueAt !== null).length }),
          t('adjust.impact.progress'),
        ]
      : action === 'carry'
        ? [
            t('adjust.impact.carryTasks', { n: open.length }),
            t('adjust.impact.keep', { pct: Math.round(item.progress) }),
          ]
        : action === 'drop'
          ? [t('adjust.impact.drop'), t('adjust.impact.tasks', { n: open.length })]
          : action === 'complete'
            ? [t('adjust.impact.complete', { pct })]
            : [t('adjust.impact.kr')];
  const primary =
    step < 3
      ? t('flow.next', { step: t(`adjust.step.${steps[step + 1]}` as MessageKey) })
      : action === 'period'
        ? t('adjust.go.period', { period: planPeriod(item!.level, target) })
        : t(`adjust.go.${action}` as MessageKey);
  return (
    <Dialog
      title={
        step === 0
          ? t('adjust.q.pick')
          : step === 1
            ? t('adjust.q.what')
            : step === 2
              ? t(`adjust.q.${action}` as MessageKey)
              : t('adjust.q.confirm')
      }
      width="md"
      onClose={onClose}
      onSubmit={() => {
        if (!canNext || busy) return;
        if (step === 3) apply();
        else setStep(step + 1);
      }}
      footer={
        <DialogFooter
          start={
            step > (initialItem ? 1 : 0) ? (
              <Button variant="secondary" onClick={() => setStep(step - 1)}>
                ‹ {t('flow.prev')}
              </Button>
            ) : undefined
          }
        >
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!canNext}>
            {primary}
          </Button>
        </DialogFooter>
      }
    >
      <span className="text-xs font-bold text-muted">
        {t('adjust.stepOf', { n: step + 1, total: 4 })}
        {step >= 2 ? ` · ${actionTitle(action)}` : ''}
      </span>
      {item && step > 0 && (
        <div className="flex flex-col gap-1 rounded-control bg-bg p-3">
          <span className="text-xs text-muted">
            {planPeriod(item.level, item.period)} · {Math.round(item.progress)}%
          </span>
          <span className="text-sm font-bold">{item.title}</span>
        </div>
      )}
      {step === 0 && (
        <ChoiceCard
          label={t('adjust.q.pick')}
          value={itemId || null}
          onChange={setItemId}
          options={mine
            .filter((p) => p.level !== 'year')
            .sort((a, b) => b.period.localeCompare(a.period))
            .slice(0, 12)
            .map((p) => ({
              value: p.id,
              title: p.title,
              description: `${levelName(p.level)} · ${planPeriod(p.level, p.period)} · ${Math.round(p.progress)}%`,
            }))}
        />
      )}
      {step === 1 && item && (
        <>
          <ChoiceCard<AdjustAction>
            label={t('adjust.q.what')}
            value={action}
            onChange={setAction}
            options={(['period', 'kr', 'carry', 'complete', 'drop'] as const).map((a) => ({
              value: a,
              title: actionTitle(a),
              description:
                a === 'kr' && krOptions.length <= 1
                  ? t('adjust.kr.none')
                  : t(`adjust.d.${a}` as MessageKey, {
                      next: planPeriod(item.level, nextPeriod),
                    }),
            }))}
          />
          <LinkButton className="self-start text-sm" onClick={() => onEditText(item)}>
            {t('adjust.editText')}
          </LinkButton>
        </>
      )}
      {step === 2 && item && action === 'period' && (
        <OptionTile
          label={t('adjust.q.period')}
          columns={3}
          value={target}
          onChange={setPeriod}
          options={periodTiles}
        />
      )}
      {step === 2 && action === 'kr' && (
        <ChoiceCard
          label={t('adjust.q.kr')}
          value={krRef}
          onChange={setKrRef}
          options={krOptions}
        />
      )}
      {step === 2 && item && action === 'carry' && (
        <>
          <ChoiceCard<CarryMode>
            label={t('adjust.q.carry')}
            value={carry}
            onChange={setCarry}
            options={[
              {
                value: 'split',
                title: t('adjust.carry.split'),
                description: t('adjust.carry.splitHint', { n: open.length }),
              },
              {
                value: 'move',
                title: t('adjust.carry.move'),
                description: t('adjust.carry.moveHint'),
              },
              {
                value: 'merge',
                title: t('adjust.carry.merge'),
                description: nextItems.length
                  ? t('adjust.carry.mergeHint')
                  : t('adjust.carry.noNext'),
              },
            ]}
          />
          {carry === 'merge' && nextItems.length > 0 && (
            <Select
              aria-label={t('adjust.carry.merge')}
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
            >
              <option value="">{t('adjust.carry.pick')}</option>
              {nextItems.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      {step === 2 && action === 'complete' && (
        <label className="flex flex-col gap-2">
          <span className="text-sm">{t('adjust.complete.how', { pct })}</span>
          <Slider
            min={0}
            max={100}
            step={5}
            value={pct}
            aria-label={t('adjust.q.complete')}
            aria-valuetext={`${pct}%`}
            onChange={(e) => setPercent(Number(e.target.value))}
          />
        </label>
      )}
      {step === 2 && action === 'drop' && (
        <>
          <ChoiceCard<DropReason>
            label={t('adjust.q.drop')}
            value={reason}
            onChange={setReason}
            options={(['direction', 'merged', 'other'] as const).map((r) => ({
              value: r,
              title: t(`adjust.reason.${r}` as MessageKey),
            }))}
          />
          <TextInput
            aria-label={t('adjust.note')}
            placeholder={t('adjust.note')}
            maxLength={150}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      )}
      {step === 3 && (
        <>
          <span className="text-sm text-muted">{t('adjust.impactHead')}</span>
          <ul className="flex flex-col gap-1.5 text-sm">
            {impacts.map((x) => (
              <li key={x} className="border-b border-line pb-1.5 last:border-b-0">
                {x}
              </li>
            ))}
          </ul>
          {(action === 'period' || (action === 'carry' && carry === 'move')) &&
            linked.some((x) => x.dueAt !== null && x.status !== 'done') && (
              <Checkbox
                label={t('adjust.moveDue')}
                checked={moveDue}
                onChange={(e) => setMoveDue(e.target.checked)}
              />
            )}
        </>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}

// ── ④ 期末回顧（G4）────────────────────────────────────────

type Outcome = 'achieved' | 'partial' | 'missed';
type Leftover = 'carry' | 'smaller' | 'drop';

interface ReviewDraft {
  window: ReviewWindow;
  step: number;
  index: number;
  answers: Record<string, { outcome: Outcome; percent: number; note: string }>;
  leftovers: Record<string, { mode: Leftover; title: string }>;
}

export function ReviewFlow({
  window: w,
  items,
  tasks,
  onCancel,
  onDone,
  onPlanNext,
  list,
}: FlowShared & {
  window: ReviewWindow;
  /** 要回顧的目標（開始時的清單） */
  list: PlanView[];
  onPlanNext: (level: PlanLevel, period: string) => void;
}) {
  const [d, setD, clear] = useDraft<ReviewDraft>(
    'hills.flow.review',
    () => ({ window: w, step: 0, index: 0, answers: {}, leftovers: {} }),
    (x) => x.window.period === w.period && x.window.level === w.level,
  );
  const set = (p: Partial<ReviewDraft>) => setD((x) => ({ ...x, ...p }));
  const { busy, error, run } = useAction();
  const [finished, setFinished] = useState<ReturnType<typeof reviewCounts> | null>(null);
  const goals = list;
  const current = goals[d.index];
  const answerOf = (p: PlanView) =>
    d.answers[p.id] ?? {
      outcome: (p.progress >= 100 ? 'achieved' : p.progress > 0 ? 'partial' : 'missed') as Outcome,
      percent: Math.round(p.progress),
      note: '',
    };
  const unfinished = goals.filter((p) => answerOf(p).outcome !== 'achieved');
  const label = planPeriod(w.level, w.period);
  const nextOf = (p: PlanView) => planPeriod(p.level, shiftPeriod(p.level, p.period, 1));
  const setAnswer = (p: PlanView, a: Partial<ReturnType<typeof answerOf>>) =>
    set({ answers: { ...d.answers, [p.id]: { ...answerOf(p), ...a } } });
  const leftoverOf = (p: PlanView) =>
    d.leftovers[p.id] ?? { mode: 'carry' as Leftover, title: p.title };
  const finish = () =>
    void run(async () => {
      const results: { outcome: ReviewOutcome; carried: boolean }[] = [];
      for (const p of goals) {
        const a = answerOf(p);
        const pct = a.outcome === 'achieved' ? 100 : a.percent;
        const base = toInput(p);
        if (a.outcome === 'achieved') {
          await api.savePlan(withReview(base, 'achieved', pct, a.note));
          results.push({ outcome: 'achieved', carried: false });
          continue;
        }
        const left = leftoverOf(p);
        if (left.mode === 'drop') {
          await api.savePlan(withReview(base, a.outcome, pct, a.note));
          results.push({ outcome: a.outcome, carried: false });
          continue;
        }
        const next = carryInput(p);
        const to = await api.savePlan({
          ...next,
          title: left.mode === 'smaller' && left.title.trim() ? left.title.trim() : p.title,
        });
        for (const x of tasks.filter((x) => x.planItemId === p.id && x.status !== 'done'))
          await api.updateTask(x.team, x.id, taskInput(x, { planItemId: to }));
        await api.savePlan(withReview(base, a.outcome, pct, a.note, to));
        results.push({ outcome: a.outcome, carried: true });
      }
      clear();
      setFinished(reviewCounts(results));
      set({ step: 2 });
    });
  const steps = ['each', 'left', 'summary'].map((k) => t(`review.step.${k}` as MessageKey));
  // 依據：連到這個目標或它下一層（週目標）的任務
  const linked = current
    ? tasks.filter(
        (x) =>
          x.planItemId === current.id ||
          items.some((c) => c.parentId === current.id && c.id === x.planItemId),
      )
    : [];
  const nextPlan = { level: w.level, period: shiftPeriod(w.level, w.period, 1) };
  const onNext = () => {
    if (d.step === 0) {
      if (d.index < goals.length - 1) set({ index: d.index + 1 });
      else if (unfinished.length) set({ step: 1 });
      else finish();
    } else if (d.step === 1) finish();
    else onDone({ message: t('review.done', { period: label }) });
  };
  return (
    <FlowFrame
      name={t('review.name', { period: label })}
      steps={steps}
      details={[
        t('review.countDone', { n: goals.length }),
        t('review.leftCount', { n: unfinished.length }),
      ]}
      current={d.step}
      onBack={
        d.step === 0
          ? d.index > 0
            ? () => set({ index: d.index - 1 })
            : null
          : d.step === 1
            ? () => set({ step: 0, index: goals.length - 1 })
            : null
      }
      next={{
        label:
          d.step === 0
            ? d.index < goals.length - 1
              ? t('review.nextGoal')
              : unfinished.length
                ? t('flow.next', { step: steps[1]! })
                : t('review.finish')
            : d.step === 1
              ? t('review.finish')
              : t('review.close'),
        onClick: onNext,
        busy,
      }}
      onExit={() => {
        clear();
        onCancel();
      }}
      onLater={onCancel}
      error={error}
      aside={
        d.step === 0 && current ? (
          <>
            <AsideHead>{t('review.aside.evidence')}</AsideHead>
            {linked.length === 0 ? (
              <p className="text-sm text-muted">{t('review.aside.noTasks')}</p>
            ) : (
              <ul className="flex flex-col">
                {linked.map((x) => (
                  <li
                    key={x.id}
                    className="flex items-center gap-2 border-b border-line py-1.5 text-sm"
                  >
                    <span
                      aria-hidden="true"
                      className={x.status === 'done' ? 'text-st-online-text' : 'text-muted'}
                    >
                      {x.status === 'done' ? '✓' : '○'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    <span className="text-xs text-muted">
                      {x.status === 'done'
                        ? t('review.aside.done')
                        : x.blocked
                          ? t('review.aside.blocked')
                          : t('review.aside.open')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {current.parentId && items.find((p) => p.id === current.parentId) && (
              <>
                <AsideHead>{t('review.aside.parent')}</AsideHead>
                <GoalBox item={items.find((p) => p.id === current.parentId)!} />
              </>
            )}
          </>
        ) : (
          <>
            <AsideHead>{t('review.aside.list')}</AsideHead>
            {goals.map((p) => (
              <span key={p.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <Badge>{t(`review.o.${answerOf(p).outcome}` as MessageKey)}</Badge>
              </span>
            ))}
          </>
        )
      }
    >
      {d.step === 0 && current && (
        <>
          <div className="flex flex-col gap-1.5 rounded-card bg-bg p-4">
            <Badge className="self-start">
              {levelName(current.level)} · {planPeriod(current.level, current.period)} ·{' '}
              {t('review.of', { n: d.index + 1, total: goals.length })}
            </Badge>
            <span className="text-base font-bold">{current.title}</span>
            <span className="flex items-center gap-2">
              <ProgressBar
                size="sm"
                className="flex-1"
                value={current.progress / 100}
                label={current.title}
              />
              <span className="text-sm">
                {t('review.byTasks', { pct: Math.round(current.progress) })}
              </span>
            </span>
          </div>
          <Question title={t('review.q.each')} />
          <OptionTile<Outcome>
            label={t('review.q.each')}
            columns={3}
            value={answerOf(current).outcome}
            onChange={(outcome) => setAnswer(current, { outcome })}
            options={(['achieved', 'partial', 'missed'] as const).map((o) => ({
              value: o,
              title: t(`review.o.${o}` as MessageKey),
              description: t(`review.h.${o}` as MessageKey),
            }))}
          />
          {answerOf(current).outcome === 'partial' && (
            <label className="flex flex-col gap-2">
              <span className="text-sm">
                {t('review.howMuch', { pct: answerOf(current).percent })}
              </span>
              <Slider
                min={0}
                max={100}
                step={5}
                value={answerOf(current).percent}
                aria-label={t('review.howMuchLabel')}
                aria-valuetext={`${answerOf(current).percent}%`}
                onChange={(e) => setAnswer(current, { percent: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-bold">{t('review.note')}</span>
            <TextInput
              maxLength={200}
              value={answerOf(current).note}
              onChange={(e) => setAnswer(current, { note: e.target.value })}
            />
          </label>
        </>
      )}
      {d.step === 1 && (
        <>
          <Question title={t('review.q.left')} help={t('review.h.left')} />
          {unfinished.map((p) => {
            const left = leftoverOf(p);
            return (
              <div
                key={p.id}
                className="flex flex-col gap-2 rounded-control border border-line p-3"
              >
                <span className="text-sm font-bold">
                  {p.title}{' '}
                  <span className="font-normal text-muted">
                    · {t(`review.o.${answerOf(p).outcome}` as MessageKey)}
                  </span>
                </span>
                <OptionTile<Leftover>
                  label={t('review.q.leftFor', { title: p.title })}
                  columns={3}
                  value={left.mode}
                  onChange={(mode) =>
                    set({ leftovers: { ...d.leftovers, [p.id]: { ...left, mode } } })
                  }
                  options={[
                    {
                      value: 'carry',
                      title: t('review.left.carry'),
                      description: t('review.left.carryHint', { next: nextOf(p) }),
                    },
                    {
                      value: 'smaller',
                      title: t('review.left.smaller'),
                      description: t('review.left.smallerHint'),
                    },
                    {
                      value: 'drop',
                      title: t('review.left.drop'),
                      description: t('review.left.dropHint'),
                    },
                  ]}
                />
                {left.mode === 'smaller' && (
                  <TextInput
                    aria-label={t('review.left.smallerLabel')}
                    maxLength={200}
                    value={left.title}
                    onChange={(e) =>
                      set({
                        leftovers: { ...d.leftovers, [p.id]: { ...left, title: e.target.value } },
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </>
      )}
      {d.step === 2 && (
        <>
          <Question title={t('review.q.summary', { period: label })} />
          {finished && (
            <p className="text-sm">
              {t('review.summary', {
                total: goals.length,
                achieved: finished.achieved,
                partial: finished.partial,
                missed: finished.missed,
                carried: finished.carried,
              })}
            </p>
          )}
          <p className="text-sm text-muted">{t('review.toReport')}</p>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              onDone({ message: t('review.done', { period: label }) });
              onPlanNext(nextPlan.level, nextPlan.period);
            }}
          >
            {t('review.planNext', { period: planPeriod(nextPlan.level, nextPlan.period) })}
          </Button>
        </>
      )}
    </FlowFrame>
  );
}
