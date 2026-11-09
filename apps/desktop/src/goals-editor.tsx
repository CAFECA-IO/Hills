/**
 * 目標編輯對話框與共用的層級顯示（ui-spec「目標 → 目標編輯對話框」v0.17；D47 起路線圖與
 * 引導式「看全部目標」共用）。
 */
import { useRef, useState } from 'react';
import {
  api,
  type KeyResult,
  type PlanInput,
  type PlanLevel,
  type PlanView,
  type TeamView,
} from './api';
import {
  LEVELS,
  joinPeriod,
  parentOptions,
  periodsFromAny,
  splitPeriod,
  weekRange,
  weeksInYear,
  yearOptions,
  type Periods,
} from './goals-utils';
import { t, type MessageKey } from './i18n';
import {
  Button,
  Checkbox,
  ConfirmButton,
  Dialog,
  EmptyState,
  ErrorText,
  Field,
  LinkButton,
  Select,
  TextInput,
  useAction,
} from './ui';

const MAX_KRS = 5;

/** 層級色（設計 token，搭配層級文字）。 */
export const LEVEL_TEXT: Record<PlanLevel, string> = {
  year: 'text-level-year',
  quarter: 'text-level-quarter',
  month: 'text-level-month',
  week: 'text-level-week',
  day: 'text-level-day',
};
export const LEVEL_BG: Record<PlanLevel, string> = {
  year: 'bg-level-year',
  quarter: 'bg-level-quarter',
  month: 'bg-level-month',
  week: 'bg-level-week',
  day: 'bg-level-day',
};
export const LEVEL_VAR: Record<PlanLevel, string> = {
  year: 'var(--hills-level-year)',
  quarter: 'var(--hills-level-quarter)',
  month: 'var(--hills-level-month)',
  week: 'var(--hills-level-week)',
  day: 'var(--hills-level-day)',
};

export const levelName = (l: PlanLevel) => t(`goals.level.${l}` as MessageKey);

export function toInput(i: PlanView): PlanInput {
  return {
    id: i.id,
    level: i.level,
    period: i.period,
    title: i.title,
    parentId: i.parentId,
    krRef: i.krRef,
    done: i.done,
    progressOverride: i.progressOverride,
    keyResults: i.keyResults,
    alignedGoalId: i.alignedGoalId,
    criteria: i.criteria,
    helps: i.helps,
    visibility: i.visibility,
  };
}

export function LockIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
      <rect x={2} y={5.5} width={8} height={5.5} rx={1.2} fill="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth={1.4} fill="none" />
    </svg>
  );
}

export function ProgressRing({
  value,
  level,
  size = 32,
}: {
  value: number;
  level: PlanLevel;
  size?: number;
}) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const v = Math.round(Math.max(0, Math.min(100, value)));
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--hills-border)"
          strokeWidth={3}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={LEVEL_VAR[level]}
          strokeWidth={3}
          fill="none"
          strokeDasharray={`${(c * v) / 100} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-2xs font-bold">
        {v}
      </span>
    </span>
  );
}

export function GoalEditor({
  initial,
  items,
  teams,
  anchor,
  onClose,
  onSaved,
  onDeleted,
}: {
  initial: PlanInput;
  items: PlanView[];
  teams: TeamView[];
  /** 目前檢視日期的五個期間：換層級時的錨點、年份選項的基準 */
  anchor: Periods;
  onClose: () => void;
  onSaved: (id: string, level: PlanLevel) => void;
  /** 刪除後（只有編輯既有目標時顯示「刪除」）；預設同關閉 */
  onDeleted?: () => void;
}) {
  const [v, setV] = useState<PlanInput>(initial);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const { busy, error, attempt } = useAction();
  const set = (patch: Partial<PlanInput>) => setV((x) => ({ ...x, ...patch }));
  const okr = v.level === 'year' || v.level === 'quarter';
  const parents = parentOptions(items, v.level, v.period).filter((p) => p.id !== v.id);
  const parent = parents.find((p) => p.id === v.parentId);
  const visValue = v.visibility.kind === 'team' ? `team:${v.visibility.team}` : v.visibility.kind;
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const setKr = (i: number, patch: Partial<KeyResult>) =>
    set({ keyResults: v.keyResults.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const save = async () => {
    if (!v.title.trim()) {
      setTitleError(t('field.required'));
      titleRef.current?.focus();
      return;
    }
    let id = '';
    const ok = await attempt(async () => {
      id = await api.savePlan({
        ...v,
        title: v.title.trim(),
        keyResults: okr ? v.keyResults : [],
        krRef: okr ? null : v.krRef,
      });
    });
    if (ok) onSaved(id, v.level);
  };
  const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
  return (
    <Dialog
      title={v.id ? t('goals.edit') : t('goals.new.title')}
      onClose={onClose}
      onSubmit={() => void save()}
      dirty={dirty}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
        <Field label={t('goals.field.level')}>
          <Select
            value={v.level}
            disabled={Boolean(v.id)}
            onChange={(e) => {
              const level = e.target.value as PlanLevel;
              set({
                level,
                period: periodsFromAny(v.period, v.level, anchor)[level],
                parentId: null,
              });
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {levelName(l)}
              </option>
            ))}
          </Select>
        </Field>
        <PeriodPicker
          level={v.level}
          value={v.period}
          baseYear={Number(anchor.year)}
          onChange={(period) => set({ period, parentId: null, krRef: null })}
        />
      </div>
      {v.level !== 'year' && (
        <Field label={t('goals.field.parent')}>
          <Select
            value={v.parentId ?? ''}
            onChange={(e) => set({ parentId: e.target.value || null, krRef: null })}
          >
            <option value="">{t('goals.field.noParent')}</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.period} · {p.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('goals.field.title')} required error={titleError}>
        <TextInput
          ref={titleRef}
          autoFocus
          maxLength={200}
          value={v.title}
          onChange={(e) => {
            set({ title: e.target.value });
            if (e.target.value.trim()) setTitleError(null);
          }}
        />
      </Field>
      {!okr && parent && parent.keyResults.length > 0 && (
        <Field label={t('goals.field.kr')}>
          <Select value={v.krRef ?? ''} onChange={(e) => set({ krRef: e.target.value || null })}>
            <option value="">{t('goals.field.noKr')}</option>
            {parent.keyResults.map((k) => (
              <option key={k.id} value={`${parent.id}/${k.id}`}>
                {k.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={t('goals.field.visibility')}
        hint={t(`goals.vis.hint.${v.visibility.kind}` as MessageKey)}
      >
        <Select
          value={visValue}
          onChange={(e) => {
            const x = e.target.value;
            set({
              visibility: x.startsWith('team:')
                ? { kind: 'team', team: x.slice(5) }
                : { kind: x as 'private' | 'org' },
            });
          }}
        >
          {teams.map((x) => (
            <option key={x.id} value={`team:${x.id}`}>
              {t('goals.vis.teamNamed', { team: x.name })}
            </option>
          ))}
          <option value="private">{t('goals.vis.private')}</option>
          <option value="org">{t('goals.vis.org')}</option>
        </Select>
      </Field>
      {okr && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted">{t('goals.krs')}</legend>
          <p className="text-xs text-muted">{t('goals.krs.hint')}</p>
          {v.keyResults.length === 0 && (
            <EmptyState art="none" className="text-xs">
              {t('goals.krs.none')}
            </EmptyState>
          )}
          {v.keyResults.map((k, i) => (
            <div
              key={k.id || i}
              className="flex flex-col gap-2 rounded-control border border-line p-2"
            >
              <div className="flex items-center gap-2">
                <TextInput
                  size="sm"
                  required
                  value={k.title}
                  maxLength={200}
                  placeholder={t('goals.kr.title')}
                  aria-label={t('goals.kr.title')}
                  onChange={(e) => setKr(i, { title: e.target.value })}
                  className="min-w-0 flex-1"
                />
                <LinkButton
                  tone="danger"
                  className="text-xs"
                  onClick={() => set({ keyResults: v.keyResults.filter((_, j) => j !== i) })}
                >
                  {t('goals.kr.remove')}
                </LinkButton>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(['start', 'target', 'current'] as const).map((f) => (
                  <Field
                    key={f}
                    label={t(
                      (f === 'current' ? 'goals.kr.current.label' : `goals.kr.${f}`) as MessageKey,
                    )}
                  >
                    <TextInput
                      size="sm"
                      type="number"
                      step="any"
                      value={k[f]}
                      onChange={(e) =>
                        setKr(i, {
                          [f]: num(e.target.value),
                          ...(f === 'current' ? { manual: true } : {}),
                        })
                      }
                    />
                  </Field>
                ))}
                <Field label={t('goals.kr.unit')}>
                  <TextInput
                    size="sm"
                    value={k.unit}
                    maxLength={16}
                    onChange={(e) => setKr(i, { unit: e.target.value })}
                  />
                </Field>
              </div>
              <Checkbox
                className="text-xs"
                label={t('goals.kr.auto')}
                checked={!k.manual}
                onChange={(e) => setKr(i, { manual: !e.target.checked })}
              />
            </div>
          ))}
          {v.keyResults.length < MAX_KRS && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() =>
                set({
                  keyResults: [
                    ...v.keyResults,
                    {
                      id: '',
                      title: '',
                      start: 0,
                      target: 100,
                      current: 0,
                      unit: '',
                      manual: true,
                    },
                  ],
                })
              }
            >
              {t('goals.kr.add')}
            </Button>
          )}
        </fieldset>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            label={t('goals.field.override')}
            checked={v.progressOverride !== null}
            onChange={(e) => set({ progressOverride: e.target.checked ? 0 : null })}
          />
          {v.progressOverride !== null && (
            <TextInput
              size="sm"
              type="number"
              min={0}
              max={100}
              value={v.progressOverride}
              aria-label={t('goals.field.override')}
              onChange={(e) =>
                set({
                  progressOverride: Math.max(0, Math.min(100, Math.round(num(e.target.value)))),
                })
              }
              className="w-20"
            />
          )}
        </div>
        <p className="text-xs text-muted">{t('goals.override.hint')}</p>
      </div>
      <ErrorText message={error} />
      <div className="flex items-center gap-2">
        {initial.id && (
          <ConfirmButton
            label={t('goals.delete')}
            message={t('goals.delete.confirm', { title: initial.title })}
            onConfirm={async () => {
              const id = initial.id;
              if (id && (await attempt(() => api.deletePlan(id)))) (onDeleted ?? onClose)();
            }}
          />
        )}
        <span className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('goals.save')}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}

/** 期間選擇器：依層級組合年份、季、月、週下拉或日期（ui-spec「目標」v0.17）。 */
function PeriodPicker({
  level,
  value,
  baseYear,
  onChange,
}: {
  level: PlanLevel;
  value: string;
  baseYear: number;
  onChange: (period: string) => void;
}) {
  const { year, n } = splitPeriod(level, value);
  const years = yearOptions(baseYear, year);
  const count =
    level === 'quarter' ? 4 : level === 'month' ? 12 : level === 'week' ? weeksInYear(year) : 0;
  const label = (i: number) => {
    if (level === 'quarter') return `Q${i}`;
    if (level === 'month') return t('goals.period.monthN', { n: i });
    const r = weekRange(year, i);
    return t('goals.period.weekN', {
      n: String(i).padStart(2, '0'),
      from: `${r.start.m}/${r.start.d}`,
      to: `${r.end.m}/${r.end.d}`,
    });
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-xs font-medium text-muted">{t('goals.field.period')}</legend>
      <div className="flex gap-2">
        <Select
          aria-label={t('goals.period.year')}
          className={count ? 'w-28 shrink-0' : 'flex-1'}
          value={year}
          onChange={(e) => onChange(joinPeriod(level, Number(e.target.value), n))}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        {count > 0 && (
          <Select
            aria-label={t(`goals.period.${level}` as MessageKey)}
            className="min-w-0 flex-1"
            value={Math.min(n, count)}
            onChange={(e) => onChange(joinPeriod(level, year, Number(e.target.value)))}
          >
            {Array.from({ length: count }, (_, k) => k + 1).map((i) => (
              <option key={i} value={i}>
                {label(i)}
              </option>
            ))}
          </Select>
        )}
      </div>
    </fieldset>
  );
}
