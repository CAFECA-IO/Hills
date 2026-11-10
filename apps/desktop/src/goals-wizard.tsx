/**
 * 引導式目標的精靈與編輯（ui-spec「目標」v0.19，D47；設計畫布 C2–C4、D4、D5）：
 * 規劃精靈（想達成什麼 → 為了團隊哪個方向 → 分到四季 → 確認）、分到下一層、
 * 設定小組方向（負責人），以及引導式的單頁編輯。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  type Criterion,
  type Direction,
  type MemberView,
  type PlanInput,
  type PlanLevel,
  type PlanView,
  type TeamGoal,
  type TeamView,
  type Visibility,
} from './api';
import type { ToastState } from './goals-guided';
import type { Periods } from './goals-utils';
import {
  alignOptions,
  childSlots,
  remainingQuarters,
  remindMonth,
  slotRange,
  suggest,
  type Slot,
} from './goals-guided-utils';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  Button,
  Card,
  Checkbox,
  ChoiceCard,
  Chip,
  ConfirmButton,
  Dialog,
  DialogFooter,
  ErrorText,
  Field,
  IconButton,
  LinkButton,
  Select,
  Stepper,
  TextInput,
  useAction,
  type ChoiceOption,
} from './ui';

const MAX_CRITERIA = 5;
const NONE = '__none';

export interface WizardShared {
  members: MemberView[];
  teams: TeamView[];
  myTeams: TeamView[];
  timezone: string;
  items: PlanView[];
  directions: Direction[];
  teamGoals: TeamGoal[];
  me: string;
}

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function defaultVisibility(myTeams: TeamView[]): Visibility {
  return myTeams[0] ? { kind: 'team', team: myTeams[0].id } : { kind: 'org' };
}

// ── 共用版面 ───────────────────────────────────────────────

function WizardFrame({
  back,
  onBack,
  steps,
  current,
  status,
  secondary,
  primary,
  busy,
  onSubmit,
  children,
}: {
  back: string;
  onBack: () => void;
  steps: string[];
  current: number;
  status: ReactNode;
  secondary: { label: string; onClick: () => void };
  primary: string;
  busy?: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="flex h-full min-h-0 flex-col items-center"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <PageHead title={t('goals.title')} />
      <div className="flex min-h-0 w-full max-w-205 flex-1 flex-col gap-4.5">
        <div className="flex items-center">
          <LinkButton className="text-sm" onClick={onBack}>
            ‹ {back}
          </LinkButton>
          <Stepper label={t('guide.steps')} steps={steps} current={current} className="ml-auto" />
        </div>
        <Card className="scroll-panel flex min-h-0 flex-1 flex-col gap-3.5 px-8 py-6.5">
          {children}
        </Card>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{status}</span>
          <span className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
            <Button type="submit" busy={busy}>
              {primary}
            </Button>
          </span>
        </div>
      </div>
    </form>
  );
}

/** 「怎麼知道做到了？」的標準列表（可以先跳過）。 */
function CriteriaInput({
  value,
  onChange,
}: {
  value: Criterion[];
  onChange: (v: Criterion[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className="text-lg font-bold">{t('guide.criteria.title')}</span>
        <span className="text-sm text-muted">{t('guide.criteria.skip')}</span>
      </div>
      <p className="text-sm text-muted">{t('guide.criteria.hint')}</p>
      {value.map((c, i) => (
        <div key={c.id} className="flex items-center gap-2">
          <TextInput
            className="flex-1"
            aria-label={t('guide.criteria.n', { n: i + 1 })}
            value={c.text}
            onChange={(e) =>
              onChange(value.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))
            }
          />
          <IconButton
            label={t('guide.criteria.remove')}
            onClick={() => onChange(value.filter((x) => x.id !== c.id))}
          >
            ×
          </IconButton>
        </div>
      ))}
      {value.length < MAX_CRITERIA && (
        <LinkButton
          className="self-start text-sm"
          onClick={() => onChange([...value, { id: newId(), text: '' }])}
        >
          {t('guide.criteria.add')}
        </LinkButton>
      )}
    </div>
  );
}

const filled = (c: Criterion[]) =>
  c.filter((x) => x.text.trim()).map((x) => ({ ...x, text: x.text.trim() }));

function slotLabel(s: Slot): string {
  const r = slotRange(s);
  if (s.level === 'quarter') {
    return t(`guide.slot.q${s.period.slice(-1)}` as MessageKey);
  }
  if (s.level === 'month') return t('goals.period.monthN', { n: r.from });
  return `${r.from} – ${r.to}`;
}

function slotHint(s: Slot): string {
  const r = slotRange(s);
  return s.level === 'quarter' ? t('guide.slot.months', { from: r.from, to: r.to }) : '';
}

/** 期間各一列的輸入（規劃精靈第 3 步、分到下一層）。 */
function SlotRows({
  slots,
  values,
  onChange,
  existing,
  criteria,
  helps,
  onHelps,
}: {
  slots: Slot[];
  values: Record<string, string>;
  onChange: (period: string, v: string) => void;
  existing: PlanView[];
  criteria: Criterion[];
  helps: Record<string, string[]>;
  onHelps: (period: string, ids: string[]) => void;
}) {
  return (
    <div className="flex flex-col">
      {slots.map((s) => {
        const have = existing.filter((p) => p.period === s.period);
        const sel = helps[s.period] ?? [];
        return (
          <div
            key={s.period}
            className="grid grid-cols-[150px_minmax(0,1fr)] items-start gap-4 border-t border-line py-3.5"
          >
            <div className="flex flex-col gap-0.5 pt-2.5">
              <span className="font-bold text-level-quarter">{slotLabel(s)}</span>
              <span className="text-xs text-muted">{slotHint(s)}</span>
            </div>
            <div className="flex flex-col gap-2">
              {have.map((p) => (
                <span key={p.id} className="rounded-control bg-bg px-3.5 py-2.5 text-muted">
                  {p.title}
                </span>
              ))}
              <TextInput
                aria-label={t('guide.slot.input', { period: slotLabel(s) })}
                placeholder={have.length ? t('guide.slot.more') : t('guide.slot.placeholder')}
                value={values[s.period] ?? ''}
                onChange={(e) => onChange(s.period, e.target.value)}
              />
              {s.level === 'quarter' && criteria.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted">{t('guide.slot.helps')}</span>
                  {criteria.map((c) => (
                    <Chip
                      key={c.id}
                      selected={sel.includes(c.id)}
                      onClick={() =>
                        onHelps(
                          s.period,
                          sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id],
                        )
                      }
                    >
                      {sel.includes(c.id) ? '✓ ' : ''}
                      {c.text}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 「對齊到哪個方向」的選項：小組目標、（展開後）公司方向，以及「跟團隊方向無關」。 */
function alignChoices(
  goals: TeamGoal[],
  directions: Direction[],
  showDirections: boolean,
  suggested: string | null,
  teams: TeamView[],
): ChoiceOption<string>[] {
  const dirTitle = (id: string | null) => directions.find((d) => d.id === id)?.title;
  const badge = (
    <span className="shrink-0 rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-bold text-primary">
      {t('guide.align.suggested')}
    </span>
  );
  return [
    ...goals.map((g) => ({
      value: g.id,
      title: g.title,
      description: [
        t('guide.align.teamGoal', { team: teams.find((x) => x.id === g.team)?.name ?? '' }),
        dirTitle(g.directionId)
          ? t('guide.align.forCompany', { title: dirTitle(g.directionId) ?? '' })
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      badge: suggested === g.id ? badge : undefined,
    })),
    ...(showDirections
      ? directions.map((d) => ({
          value: d.id,
          title: d.title,
          description: t('guide.align.company'),
          badge: suggested === d.id ? badge : undefined,
        }))
      : []),
    {
      value: NONE,
      title: t('guide.align.none'),
      description: t('guide.align.noneHint'),
      dashed: true,
    },
  ];
}

// ── 規劃精靈（年） ─────────────────────────────────────────

export function PlanWizard({
  year,
  now,
  myTeams,
  teams,
  directions,
  teamGoals,
  onCancel,
  onDone,
}: WizardShared & {
  year: string;
  /** 規劃今年時，已過的季不列（ui-spec v0.24） */
  now?: Periods;
  onCancel: () => void;
  onDone: (s: ToastState) => void;
}) {
  const goals = alignOptions(
    teamGoals,
    myTeams.map((x) => x.id),
    year,
  );
  const dirs = directions.filter((d) => d.year === year);
  const withAlign = goals.length + dirs.length > 0;
  const stepKeys = withAlign
    ? ['what', 'align', 'quarters', 'review']
    : ['what', 'quarters', 'review'];
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>([{ id: newId(), text: '' }]);
  const [priv, setPriv] = useState(false);
  const [aligned, setAligned] = useState<string | null>(null);
  const [showDirs, setShowDirs] = useState(goals.length === 0);
  const [quarters, setQuarters] = useState<Record<string, string>>({});
  const [helps, setHelps] = useState<Record<string, string[]>>({});
  const [override, setOverride] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const key = stepKeys[step];
  const left = now ? remainingQuarters(year, now) : null;
  const slots = childSlots('year', year).filter((s) => !left || left.includes(s.period));
  const crit = filled(criteria);
  const suggested = suggest(title, [...goals, ...dirs]);
  const vis: Visibility = priv ? { kind: 'private' } : defaultVisibility(myTeams);

  const next = () => {
    if (key === 'what') {
      if (!title.trim()) {
        setTitleError(t('field.required'));
        return;
      }
      if (withAlign && aligned === null) {
        setAligned(suggested ?? null);
        if (suggested && dirs.some((d) => d.id === suggested)) setShowDirs(true);
      }
    }
    if (key === 'review') {
      void create();
      return;
    }
    setStep((s) => s + 1);
  };

  const create = async () => {
    const created: string[] = [];
    const ok = await run(async () => {
      const alignedGoalId = aligned && aligned !== NONE ? aligned : null;
      const base: PlanInput = {
        level: 'year',
        period: year,
        title: title.trim(),
        parentId: null,
        krRef: null,
        done: false,
        progressOverride: override,
        keyResults: [],
        alignedGoalId,
        criteria: crit,
        helps: [],
        visibility: vis,
      };
      const y = await api.savePlan(base);
      created.push(y);
      for (const s of slots) {
        const text = quarters[s.period]?.trim();
        if (!text) continue;
        created.push(
          await api.savePlan({
            ...base,
            level: 'quarter',
            period: s.period,
            title: text,
            parentId: y,
            progressOverride: null,
            criteria: [],
            helps: (helps[s.period] ?? []).filter((h) => crit.some((c) => c.id === h)),
          }),
        );
      }
      return true;
    });
    if (!ok) return;
    onDone({
      message: t('guide.created', { quarters: created.length - 1 }),
      undo: async () => {
        for (const id of [...created].reverse()) await api.deletePlan(id);
      },
    });
  };

  const filledQuarters = slots.filter((s) => quarters[s.period]?.trim());
  const status =
    key === 'quarters'
      ? t('guide.quarters.count', { n: filledQuarters.length })
      : key === 'review'
        ? t('guide.review.count', { n: filledQuarters.length })
        : key === 'what'
          ? t('guide.enterHint')
          : t('guide.align.status');

  return (
    <WizardFrame
      back={step === 0 ? t('guide.backHome') : t('guide.prev')}
      onBack={step === 0 ? onCancel : () => setStep((s) => s - 1)}
      steps={stepKeys.map((k) => t(`guide.step.${k}` as MessageKey))}
      current={step}
      status={status}
      secondary={
        step === 0
          ? { label: t('common.cancel'), onClick: onCancel }
          : { label: t('guide.prev'), onClick: () => setStep((s) => s - 1) }
      }
      primary={
        key === 'review'
          ? t('guide.review.create')
          : t('guide.nextTo', { step: t(`guide.step.${stepKeys[step + 1]}` as MessageKey) })
      }
      busy={busy}
      onSubmit={next}
    >
      {key === 'what' && (
        <>
          <Field
            label={t('guide.what.title', { year })}
            hint={t('guide.what.hint')}
            error={titleError}
            required
          >
            <TextInput
              autoFocus
              className="h-13 text-lg font-semibold"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleError(null);
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">{t('guide.what.examples')}</span>
            {(['a', 'b', 'c'] as const).map((k) => (
              <Chip key={k} onClick={() => setTitle(t(`guide.what.example.${k}` as MessageKey))}>
                {t(`guide.what.example.${k}` as MessageKey)}
              </Chip>
            ))}
          </div>
          <div className="mt-3">
            <CriteriaInput value={criteria} onChange={setCriteria} />
          </div>
          <div className="mt-auto flex items-center gap-2 border-t border-line pt-4 text-sm text-muted">
            {priv ? t('guide.vis.private') : t('guide.vis.team')}
            <LinkButton onClick={() => setPriv((p) => !p)}>
              {priv ? t('guide.vis.toTeam') : t('guide.vis.toPrivate')}
            </LinkButton>
          </div>
        </>
      )}
      {key === 'align' && (
        <>
          <h2 className="text-2xl font-bold">{t('guide.align.title', { title: title.trim() })}</h2>
          <p className="text-sm text-muted">{t('guide.align.hint')}</p>
          <ChoiceCard
            label={t('guide.step.align')}
            options={alignChoices(goals, dirs, showDirs, suggested, teams)}
            value={aligned}
            onChange={setAligned}
          />
          {!showDirs && dirs.length > 0 && (
            <LinkButton className="self-start text-sm" onClick={() => setShowDirs(true)}>
              {t('guide.align.showCompany')}
            </LinkButton>
          )}
        </>
      )}
      {key === 'quarters' && (
        <>
          <h2 className="text-2xl font-bold">
            {t('guide.quarters.title', { title: title.trim() })}
          </h2>
          <p className="text-sm text-muted">{t('guide.quarters.hint')}</p>
          <SlotRows
            slots={slots}
            values={quarters}
            onChange={(p, v) => setQuarters((q) => ({ ...q, [p]: v }))}
            existing={[]}
            criteria={crit}
            helps={helps}
            onHelps={(p, ids) => setHelps((h) => ({ ...h, [p]: ids }))}
          />
        </>
      )}
      {key === 'review' && (
        <>
          <h2 className="text-2xl font-bold">{t('guide.review.title')}</h2>
          <p className="text-sm text-muted">{t('guide.review.hint')}</p>
          <ReviewTree
            year={year}
            title={title.trim()}
            criteria={crit}
            alignedTitle={
              aligned && aligned !== NONE
                ? ([...goals, ...dirs].find((g) => g.id === aligned)?.title ?? null)
                : null
            }
            slots={slots.map((s) => ({
              label: slotLabel(s),
              title: quarters[s.period]?.trim() ?? '',
              helps: (helps[s.period] ?? [])
                .map((h) => crit.find((c) => c.id === h)?.text)
                .filter((x): x is string => Boolean(x)),
              remind: remindMonth(s.period),
            }))}
            onEdit={(k) => setStep(stepKeys.indexOf(k))}
          />
          <details className="mt-auto border-t border-line pt-3">
            <summary className="cursor-pointer text-sm text-muted">
              {t('guide.review.more')}
            </summary>
            <div className="flex flex-col gap-3 pt-3">
              <Checkbox
                label={t('guide.vis.privateOption')}
                checked={priv}
                onChange={(e) => setPriv(e.target.checked)}
              />
              <div className="flex items-center gap-3">
                <Checkbox
                  label={t('goals.field.override')}
                  checked={override !== null}
                  onChange={(e) => setOverride(e.target.checked ? 0 : null)}
                />
                {override !== null && (
                  <TextInput
                    type="number"
                    size="sm"
                    className="w-20"
                    min={0}
                    max={100}
                    aria-label={t('goals.field.override')}
                    value={String(override)}
                    onChange={(e) =>
                      setOverride(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                    }
                  />
                )}
              </div>
            </div>
          </details>
        </>
      )}
      <ErrorText message={error} />
    </WizardFrame>
  );
}

function ReviewTree({
  year,
  title,
  criteria,
  alignedTitle,
  slots,
  onEdit,
}: {
  year: string;
  title: string;
  criteria: Criterion[];
  alignedTitle: string | null;
  slots: { label: string; title: string; helps: string[]; remind: number }[];
  onEdit: (step: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 rounded-card border border-line bg-primary-soft px-4 py-3">
        <span className="w-12 text-xs font-bold text-level-year">{year}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-base font-bold">{title}</span>
          {criteria.length > 0 && (
            <span className="text-sm text-muted">
              {t('guide.review.criteria', { list: criteria.map((c) => c.text).join(' · ') })}
            </span>
          )}
          {alignedTitle && (
            <span className="text-sm text-muted">
              {t('guide.forTitle', { title: alignedTitle })}
            </span>
          )}
        </div>
        <LinkButton className="text-sm" onClick={() => onEdit('what')}>
          {t('guide.review.edit')}
        </LinkButton>
      </div>
      <div className="ml-5.5 flex flex-col gap-2 border-l-2 border-line pl-7">
        {slots.map((s) =>
          s.title ? (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
            >
              <span className="w-12 text-xs font-bold text-level-quarter">{s.label}</span>
              <span className="flex-1 font-semibold">{s.title}</span>
              {s.helps.length > 0 && (
                <span className="text-xs text-muted">
                  {t('guide.review.helps', { list: s.helps.join('、') })}
                </span>
              )}
              <LinkButton className="text-sm" onClick={() => onEdit('quarters')}>
                {t('guide.review.edit')}
              </LinkButton>
            </div>
          ) : (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-card border border-dashed border-line bg-bg px-4 py-3"
            >
              <span className="w-12 text-xs font-bold text-level-quarter">{s.label}</span>
              <span className="flex-1 text-muted">
                {t('guide.review.empty', { month: s.remind })}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// ── 分到下一層 ─────────────────────────────────────────────

const CHILD_KEY: Partial<Record<PlanLevel, string>> = {
  year: 'quarter',
  quarter: 'month',
  month: 'week',
};

export function BreakdownWizard({
  parent,
  items,
  onCancel,
  onDone,
}: WizardShared & {
  parent: PlanView;
  onCancel: () => void;
  onDone: (s: ToastState) => void;
}) {
  const slots = childSlots(parent.level, parent.period);
  const child = CHILD_KEY[parent.level] ?? 'quarter';
  const existing = items.filter((p) => p.mine && p.parentId === parent.id);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [helps, setHelps] = useState<Record<string, string[]>>({});
  const { busy, error, run } = useAction();
  const toCreate = slots.filter((s) => values[s.period]?.trim());
  const create = async () => {
    const created: string[] = [];
    const ok = await run(async () => {
      for (const s of toCreate) {
        created.push(
          await api.savePlan({
            level: s.level,
            period: s.period,
            title: values[s.period]?.trim() ?? '',
            parentId: parent.id,
            krRef: null,
            done: false,
            progressOverride: null,
            keyResults: [],
            alignedGoalId: s.level === 'quarter' ? parent.alignedGoalId : null,
            criteria: [],
            helps: s.level === 'quarter' ? (helps[s.period] ?? []) : [],
            visibility: parent.visibility,
          }),
        );
      }
      return true;
    });
    if (!ok) return;
    onDone({
      message: t('guide.breakdown.created', { n: created.length }),
      undo: async () => {
        for (const id of created) await api.deletePlan(id);
      },
    });
  };
  const steps = [t(`guide.breakdown.step.${child}` as MessageKey), t('guide.step.review')];
  return (
    <WizardFrame
      back={step === 0 ? t('guide.backHome') : t('guide.prev')}
      onBack={step === 0 ? onCancel : () => setStep(0)}
      steps={steps}
      current={step}
      status={t('guide.breakdown.count', { n: toCreate.length })}
      secondary={
        step === 0
          ? { label: t('common.cancel'), onClick: onCancel }
          : { label: t('guide.prev'), onClick: () => setStep(0) }
      }
      primary={
        step === 0 ? t('guide.nextTo', { step: steps[1] ?? '' }) : t('guide.breakdown.create')
      }
      busy={busy}
      onSubmit={() => (step === 0 ? setStep(1) : void create())}
    >
      {step === 0 ? (
        <>
          <h2 className="text-2xl font-bold">
            {t(`guide.breakdown.title.${child}` as MessageKey, { title: parent.title })}
          </h2>
          <p className="text-sm text-muted">{t('guide.breakdown.hint')}</p>
          <SlotRows
            slots={slots}
            values={values}
            onChange={(p, v) => setValues((x) => ({ ...x, [p]: v }))}
            existing={existing}
            criteria={parent.level === 'year' ? parent.criteria : []}
            helps={helps}
            onHelps={(p, ids) => setHelps((h) => ({ ...h, [p]: ids }))}
          />
        </>
      ) : (
        <>
          <h2 className="text-2xl font-bold">{t('guide.review.title')}</h2>
          <div className="flex items-center gap-3 rounded-card border border-line bg-primary-soft px-4 py-3">
            <span className="flex-1 text-base font-bold">{parent.title}</span>
          </div>
          <div className="ml-5.5 flex flex-col gap-2 border-l-2 border-line pl-7">
            {slots.map((s) => {
              const text = values[s.period]?.trim();
              const have = existing.filter((p) => p.period === s.period);
              return (
                <div
                  key={s.period}
                  className={`flex items-center gap-3 rounded-card border border-line px-4 py-3 ${text ? 'bg-surface' : 'border-dashed bg-bg'}`}
                >
                  <span className="w-20 text-xs font-bold text-level-quarter">{slotLabel(s)}</span>
                  <span className={`flex-1 ${text ? 'font-semibold' : 'text-muted'}`}>
                    {text ||
                      (have.length
                        ? have.map((p) => p.title).join('、')
                        : t('guide.breakdown.empty'))}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <ErrorText message={error} />
    </WizardFrame>
  );
}

// ── 設定小組方向（負責人） ─────────────────────────────────

export function TeamGoalWizard({
  team,
  goal,
  year,
  teams,
  directions,
  onCancel,
  onDone,
}: WizardShared & {
  team: string;
  goal: TeamGoal | null;
  year: string;
  onCancel: () => void;
  onDone: (s: ToastState) => void;
}) {
  const teamName = teams.find((x) => x.id === team)?.name ?? '';
  const dirs = directions.filter((d) => d.year === year);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<string | null>(
    goal ? (goal.directionId ?? NONE) : null,
  );
  const [title, setTitle] = useState(goal?.title ?? '');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>(
    goal?.criteria.length ? goal.criteria : [{ id: newId(), text: '' }],
  );
  const { busy, error, run } = useAction();
  const keys = ['direction', 'criteria', 'review'];
  const save = async () => {
    const id = await run(() =>
      api.saveTeamGoal({
        id: goal?.id ?? null,
        team,
        year,
        title: title.trim(),
        directionId: direction && direction !== NONE ? direction : null,
        keyResults: goal?.keyResults ?? [],
        criteria: filled(criteria),
      }),
    );
    if (!id) return;
    onDone({
      message: t('guide.teamGoal.saved', { title: title.trim() }),
      undo: goal ? undefined : () => api.deleteTeamGoal(team, id),
    });
  };
  const next = () => {
    if (step === 0 && !title.trim()) {
      setTitleError(t('field.required'));
      return;
    }
    if (step === 2) {
      void save();
      return;
    }
    setStep((s) => s + 1);
  };
  const dirTitle = dirs.find((d) => d.id === direction)?.title;
  return (
    <WizardFrame
      back={step === 0 ? t('guide.backTeam') : t('guide.prev')}
      onBack={step === 0 ? onCancel : () => setStep((s) => s - 1)}
      steps={keys.map((k) => t(`guide.teamGoal.step.${k}` as MessageKey))}
      current={step}
      status={t('guide.teamGoal.status')}
      secondary={
        step === 0
          ? { label: t('common.cancel'), onClick: onCancel }
          : { label: t('guide.prev'), onClick: () => setStep((s) => s - 1) }
      }
      primary={
        step === 2
          ? goal
            ? t('common.save')
            : t('guide.teamGoal.create')
          : t('guide.nextTo', {
              step: t(`guide.teamGoal.step.${keys[step + 1]}` as MessageKey),
            })
      }
      busy={busy}
      onSubmit={next}
    >
      {step === 0 && (
        <>
          <h2 className="text-2xl font-bold">
            {t('guide.teamGoal.title', { team: teamName, year })}
          </h2>
          <p className="text-sm text-muted">{t('guide.teamGoal.hint')}</p>
          <ChoiceCard
            label={t('guide.teamGoal.step.direction')}
            options={[
              ...dirs.map((d, i) => ({
                value: d.id,
                title: d.title,
                description: t('guide.team.direction', { n: i + 1 }),
              })),
              {
                value: NONE,
                title: t('guide.teamGoal.none'),
                description: t('guide.teamGoal.noneHint'),
                dashed: true,
              },
            ]}
            value={direction}
            onChange={setDirection}
          />
          {direction !== null && (
            <div className="mt-1.5 border-t border-line pt-3.5">
              <Field label={t('guide.teamGoal.what', { year })} error={titleError} required>
                <TextInput
                  autoFocus
                  className="h-13 text-lg font-semibold"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleError(null);
                  }}
                />
              </Field>
            </div>
          )}
        </>
      )}
      {step === 1 && <CriteriaInput value={criteria} onChange={setCriteria} />}
      {step === 2 && (
        <>
          <h2 className="text-2xl font-bold">{t('guide.review.title')}</h2>
          <div className="flex flex-col gap-1 rounded-card border border-line bg-primary-soft px-4 py-3">
            <span className="text-xs font-bold text-level-quarter">{teamName}</span>
            <span className="text-base font-bold">{title.trim()}</span>
            <span className="text-sm text-muted">
              {dirTitle ? t('guide.forTitle', { title: dirTitle }) : t('guide.team.unaligned')}
            </span>
            {filled(criteria).length > 0 && (
              <span className="text-sm text-muted">
                {t('guide.review.criteria', {
                  list: filled(criteria)
                    .map((c) => c.text)
                    .join(' · '),
                })}
              </span>
            )}
          </div>
        </>
      )}
      <ErrorText message={error} />
    </WizardFrame>
  );
}

// ── 引導式的單頁編輯 ───────────────────────────────────────

export function GuidedEditor({
  item,
  myTeams,
  teams,
  directions,
  teamGoals,
  onBreakdown,
  onClose,
  onSaved,
}: WizardShared & {
  item: PlanView;
  /** 我的年 / 季 / 月目標：隨時分到下一層（ui-spec v0.24） */
  onBreakdown?: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const okr = item.level === 'year' || item.level === 'quarter';
  const year = item.period.slice(0, 4);
  const [title, setTitle] = useState(item.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [criteria, setCriteria] = useState<Criterion[]>(item.criteria);
  const [aligned, setAligned] = useState(item.alignedGoalId ?? '');
  const { busy, error, attempt } = useAction();
  const goals = alignOptions(
    teamGoals,
    myTeams.map((x) => x.id),
    year,
  );
  const dirs = directions.filter((d) => d.year === year);
  const dirty =
    title !== item.title ||
    aligned !== (item.alignedGoalId ?? '') ||
    JSON.stringify(criteria) !== JSON.stringify(item.criteria);
  const save = async () => {
    if (!title.trim()) {
      setTitleError(t('field.required'));
      return;
    }
    const ok = await attempt(() =>
      api.savePlan({
        id: item.id,
        level: item.level,
        period: item.period,
        title: title.trim(),
        parentId: item.parentId,
        krRef: item.krRef,
        done: item.done,
        progressOverride: item.progressOverride,
        keyResults: item.keyResults,
        alignedGoalId: okr ? aligned || null : null,
        criteria: okr ? filled(criteria) : [],
        helps: item.helps,
        visibility: item.visibility,
      }),
    );
    if (ok) onSaved();
  };
  return (
    <Dialog
      title={t('guide.edit.title')}
      onClose={onClose}
      onSubmit={save}
      dirty={dirty}
      footer={
        <DialogFooter
          start={
            <>
              <ConfirmButton
                label={t('goals.delete')}
                message={t('goals.delete.confirm', { title: item.title })}
                onConfirm={async () => {
                  if (await attempt(() => api.deletePlan(item.id))) onSaved();
                }}
              />
              {onBreakdown && (
                <LinkButton className="text-sm" onClick={onBreakdown}>
                  {t('guide.edit.breakdown')}
                </LinkButton>
              )}
            </>
          }
        >
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      }
    >
      <Field label={t('goals.field.title')} error={titleError} required>
        <TextInput
          autoFocus
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleError(null);
          }}
        />
      </Field>
      {okr && (
        <>
          <Field label={t('guide.edit.align')}>
            <Select value={aligned} onChange={(e) => setAligned(e.target.value)}>
              <option value="">{t('guide.align.none')}</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}（{teams.find((x) => x.id === g.team)?.name ?? ''}）
                </option>
              ))}
              {dirs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}（{t('guide.align.company')}）
                </option>
              ))}
            </Select>
          </Field>
          <CriteriaInput value={criteria} onChange={setCriteria} />
        </>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}
