/** 目標「階梯」（ui-spec「目標」，D43、D8；technical-design §16.10）。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type KeyResult,
  type MemberView,
  type PlanInput,
  type PlanLevel,
  type PlanView,
  type Task,
  type TeamView,
  type Visibility,
} from './api';
import {
  columnItems,
  LEVELS,
  nextLevel,
  parentOptions,
  periodLabel,
  periodsAt,
  select,
  todayTasks,
  type Periods,
  type Selection,
} from './goals-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmButton,
  Dialog,
  ErrorText,
  Field,
  LinkButton,
  Pressable,
  ProgressBar,
  Select,
  TextInput,
  useAction,
} from './ui';

const DAY_MS = 86_400_000;
const MAX_KRS = 5;

/** 層級色（設計 token，搭配層級文字）。 */
const LEVEL_TEXT: Record<PlanLevel, string> = {
  year: 'text-level-year',
  quarter: 'text-level-quarter',
  month: 'text-level-month',
  week: 'text-level-week',
  day: 'text-level-day',
};
const LEVEL_BG: Record<PlanLevel, string> = {
  year: 'bg-level-year',
  quarter: 'bg-level-quarter',
  month: 'bg-level-month',
  week: 'bg-level-week',
  day: 'bg-level-day',
};
const LEVEL_VAR: Record<PlanLevel, string> = {
  year: 'var(--hills-level-year)',
  quarter: 'var(--hills-level-quarter)',
  month: 'var(--hills-level-month)',
  week: 'var(--hills-level-week)',
  day: 'var(--hills-level-day)',
};

const levelName = (l: PlanLevel) => t(`goals.level.${l}` as MessageKey);

interface Props {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
  onOpenTasks: () => void;
}

export function Goals({ members, teams, tasks, focusId, timezone, onOpenTasks }: Props) {
  const [mineOnly, setMineOnly] = useState(true);
  const plans = useLoad(() => api.plans(mineOnly), ['doc', 'org', 'roster']);
  const reload = plans.reload;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineOnly]);
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState<Selection>({});
  const [editing, setEditing] = useState<PlanInput | null>(null);
  const items = useMemo(() => plans.data ?? [], [plans.data]);
  // 「今天」每分鐘更新一次（跨日時欄位跟著換）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const periods = periodsAt(now + offset * DAY_MS, timezone);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  const selected = useMemo(() => {
    for (const l of [...LEVELS].reverse()) {
      const id = sel[l];
      if (id) return items.find((i) => i.id === id) ?? null;
    }
    return null;
  }, [sel, items]);
  const defaultVis: Visibility = myTeams[0]
    ? { kind: 'team', team: myTeams[0].id }
    : { kind: 'org' };
  const blank = (level: PlanLevel, parent: PlanView | null = null): PlanInput => ({
    id: null,
    level,
    period: periods[level],
    title: '',
    parentId: parent?.mine ? parent.id : null,
    krRef: null,
    done: false,
    progressOverride: null,
    keyResults: [],
    visibility: parent?.mine ? parent.visibility : defaultVis,
  });
  const dayTasks = todayTasks(tasks, focusId, periods.day, timezone);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead
        title={t('goals.title')}
        subtitle={t('goals.subtitle')}
        actions={
          <>
            <Checkbox
              className="h-9 rounded-full bg-surface px-3 shadow-sm"
              label={t('goals.mineOnly')}
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            <Button onClick={() => setEditing(blank('quarter'))}>{t('goals.new')}</Button>
          </>
        }
      />
      <div className="flex items-center gap-2 text-sm">
        <Button
          variant="secondary"
          className="h-8 px-3 py-0"
          aria-label={t('goals.prevDay')}
          onClick={() => setOffset((o) => o - 1)}
        >
          ◀
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 py-0"
          disabled={offset === 0}
          onClick={() => setOffset(0)}
        >
          {t('goals.today')}
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-3 py-0"
          aria-label={t('goals.nextDay')}
          onClick={() => setOffset((o) => o + 1)}
        >
          ▶
        </Button>
        <span className="text-muted">{periods.day}</span>
        <ErrorText message={plans.error} />
      </div>
      <Ladder
        items={items}
        periods={periods}
        sel={sel}
        onSelect={(level, id) => setSel((s) => select(s, level, s[level] === id ? null : id))}
        onAdd={(level) => {
          const prev = LEVELS[LEVELS.indexOf(level) - 1];
          const parent = prev ? (items.find((i) => i.id === sel[prev]) ?? null) : null;
          setEditing(blank(level, parent));
        }}
        nameOf={nameOf}
        dayTasks={dayTasks}
        onOpenTasks={onOpenTasks}
      />
      <SelectedPanel
        item={selected}
        items={items}
        teams={teams}
        nameOf={nameOf}
        onEdit={(i) => setEditing(toInput(i))}
        onSplit={(i) => {
          const next = nextLevel(i.level);
          if (next) setEditing(blank(next, i));
        }}
        onDeleted={() => setSel({})}
      />
      {editing && (
        <GoalEditor
          initial={editing}
          items={items}
          teams={myTeams}
          onClose={() => setEditing(null)}
          onSaved={(id, level) => {
            setEditing(null);
            setSel((s) => select(s, level, id));
            plans.reload();
          }}
        />
      )}
    </div>
  );
}

function toInput(i: PlanView): PlanInput {
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
    visibility: i.visibility,
  };
}

// ── 五欄 ─────────────────────────────────────────────────────

function Ladder({
  items,
  periods,
  sel,
  onSelect,
  onAdd,
  nameOf,
  dayTasks,
  onOpenTasks,
}: {
  items: PlanView[];
  periods: Periods;
  sel: Selection;
  onSelect: (level: PlanLevel, id: string) => void;
  onAdd: (level: PlanLevel) => void;
  nameOf: (id: string) => string;
  dayTasks: Task[];
  onOpenTasks: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ d: string; color: string; key: string }[]>([]);
  const [tick, setTick] = useState(0);
  const periodKey = LEVELS.map((l) => periods[l]).join('|');
  const cols = useMemo(
    () => LEVELS.map((l) => columnItems(items, l, periods, sel)),
    // periods 以 periodKey 代表
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, periodKey, sel],
  );
  // 選取鏈的連線：選取卡片右緣 → 下一欄各子目標左緣（層級色）
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const out: { d: string; color: string; key: string }[] = [];
    LEVELS.forEach((l, i) => {
      const id = sel[l];
      const next = LEVELS[i + 1];
      if (!id || !next) return;
      const from = root.querySelector<HTMLElement>(`[data-goal="${l}:${id}"]`);
      if (!from) return;
      const a = from.getBoundingClientRect();
      const ax = a.right - base.left;
      const ay = a.top + a.height / 2 - base.top;
      for (const c of cols[i + 1] ?? []) {
        const to = root.querySelector<HTMLElement>(`[data-goal="${next}:${c.id}"]`);
        if (!to) continue;
        const b = to.getBoundingClientRect();
        const bx = b.left - base.left;
        const by = b.top + b.height / 2 - base.top;
        if (by < 0 || by > base.height) continue;
        const mx = (ax + bx) / 2;
        out.push({
          key: `${id}-${c.id}`,
          color: LEVEL_VAR[next],
          d: `M${ax} ${ay}C${mx} ${ay} ${mx} ${by} ${bx} ${by}`,
        });
      }
    });
    setLines((prev) =>
      prev.length === out.length && prev.every((p, k) => p.d === out[k]?.d) ? prev : out,
    );
  }, [sel, cols, tick]);
  return (
    <div ref={box} className="relative grid min-h-0 flex-1 grid-cols-5 gap-3 wide:gap-4">
      {LEVELS.map((l, i) => (
        <LevelColumn
          key={l}
          level={l}
          period={periods[l]}
          items={cols[i] ?? []}
          selected={sel[l]}
          onSelect={(id) => onSelect(l, id)}
          onAdd={() => onAdd(l)}
          nameOf={nameOf}
          onScroll={() => setTick(tick + 1)}
          extra={
            l === 'day' && dayTasks.length > 0 ? (
              <TaskRows tasks={dayTasks} onOpen={onOpenTasks} />
            ) : null
          }
        />
      ))}
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full">
        {lines.map((x) => (
          <path key={x.key} d={x.d} stroke={x.color} strokeWidth={2} fill="none" opacity={0.7} />
        ))}
      </svg>
    </div>
  );
}

function LevelColumn({
  level,
  period,
  items,
  selected,
  onSelect,
  onAdd,
  nameOf,
  onScroll,
  extra,
}: {
  level: PlanLevel;
  period: string;
  items: PlanView[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  onAdd: () => void;
  nameOf: (id: string) => string;
  onScroll: () => void;
  extra: ReactNode;
}) {
  return (
    <section
      aria-label={`${levelName(level)} ${period}`}
      className="flex min-h-0 min-w-0 flex-col rounded-card bg-surface shadow-sm"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="flex items-center gap-2">
          <span aria-hidden className={`size-2.5 rounded-full ${LEVEL_BG[level]}`} />
          <span className={`text-xs font-bold ${LEVEL_TEXT[level]}`}>{levelName(level)}</span>
          <span className="text-sm font-bold">{periodLabel(level, period)}</span>
        </span>
        <span className="text-xs text-muted">{items.length}</span>
      </header>
      <ul className="scroll-panel flex min-h-0 flex-1 flex-col gap-2 p-2" onScroll={onScroll}>
        {items.length === 0 && !extra && (
          <li className="px-1 py-2 text-xs text-muted">{t('goals.column.empty')}</li>
        )}
        {items.map((i) => (
          <li key={i.id}>
            <Pressable
              data-goal={`${level}:${i.id}`}
              aria-pressed={selected === i.id}
              onClick={() => onSelect(i.id)}
              className={`flex w-full items-center gap-2 rounded-control border px-2 py-2 text-sm ${selected === i.id ? 'border-primary bg-primary-soft' : 'border-line hover:bg-bg'}`}
            >
              <ProgressRing value={i.progress} level={level} />
              <span className="flex min-w-0 flex-col">
                <span className={`line-clamp-2 ${i.done ? 'text-muted line-through' : ''}`}>
                  {i.title}
                </span>
                {!i.mine && <span className="truncate text-xs text-muted">{nameOf(i.owner)}</span>}
              </span>
            </Pressable>
          </li>
        ))}
        {extra}
      </ul>
      <div className="border-t border-line p-2">
        <Button variant="ghost" size="sm" className="w-full rounded-control" onClick={onAdd}>
          {t('goals.add', { level: levelName(level) })}
        </Button>
      </div>
    </section>
  );
}

function TaskRows({ tasks, onOpen }: { tasks: Task[]; onOpen: () => void }) {
  return (
    <>
      <li className="px-1 pt-1 text-xs font-bold text-muted">{t('goals.todayTasks')}</li>
      {tasks.map((x) => (
        <li key={`${x.team}:${x.id}`}>
          <Pressable
            onClick={onOpen}
            className="flex w-full items-center gap-2 rounded-control border border-dashed border-line px-2 py-2 text-sm hover:bg-bg"
          >
            <Badge>{t('goals.taskBadge')}</Badge>
            <span className="line-clamp-2">{x.title}</span>
          </Pressable>
        </li>
      ))}
    </>
  );
}

function ProgressRing({
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

// ── 已選區 ───────────────────────────────────────────────────

function visLabel(v: Visibility, teams: TeamView[]): string {
  if (v.kind === 'team') {
    return t('goals.vis.teamNamed', { team: teams.find((x) => x.id === v.team)?.name ?? '' });
  }
  return t(`goals.vis.${v.kind}` as MessageKey);
}

function SelectedPanel({
  item,
  items,
  teams,
  nameOf,
  onEdit,
  onSplit,
  onDeleted,
}: {
  item: PlanView | null;
  items: PlanView[];
  teams: TeamView[];
  nameOf: (id: string) => string;
  onEdit: (i: PlanView) => void;
  onSplit: (i: PlanView) => void;
  onDeleted: () => void;
}) {
  const { busy, error, attempt } = useAction();
  if (!item) {
    return (
      <section className="flex h-40 shrink-0 items-center justify-center rounded-card bg-surface text-sm text-muted shadow-sm wide:h-48">
        {t('goals.pickHint')}
      </section>
    );
  }
  const parent = item.parentId ? items.find((i) => i.id === item.parentId) : null;
  const next = nextLevel(item.level);
  const linkedKr = (() => {
    if (!item.krRef) return null;
    const [pid, kid] = item.krRef.split('/');
    return items.find((i) => i.id === pid)?.keyResults.find((k) => k.id === kid) ?? null;
  })();
  return (
    <section className="grid h-40 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 rounded-card bg-surface p-4 shadow-sm wide:h-48">
      <div className="flex min-w-0 flex-col gap-1">
        <span className={`text-xs font-bold ${LEVEL_TEXT[item.level]}`}>
          {t('goals.selected', { level: levelName(item.level) })} · {item.period}
        </span>
        <span className="truncate text-lg font-bold" title={item.title}>
          {item.title}
        </span>
        <span className="truncate text-xs text-muted">
          {item.mine ? t('goals.owner.me') : nameOf(item.owner)} ·{' '}
          {visLabel(item.visibility, teams)}
          {item.parentId &&
            ` · ${t('goals.alignedTo', { title: parent?.title ?? t('goals.privateItem') })}`}
        </span>
        {linkedKr && (
          <span className="truncate text-xs text-muted">
            {t('goals.linkedKr', { title: linkedKr.title })}
          </span>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {item.mine && (
            <>
              <Button variant="secondary" className="h-8 px-3 py-0" onClick={() => onEdit(item)}>
                {t('goals.edit')}
              </Button>
              {next && (
                <Button variant="secondary" className="h-8 px-3 py-0" onClick={() => onSplit(item)}>
                  {t('goals.split', { level: levelName(next) })}
                </Button>
              )}
              <ConfirmButton
                label={t('goals.delete')}
                message={t('goals.delete.confirm', { title: item.title })}
                onConfirm={async () => {
                  if (await attempt(() => api.deletePlan(item.id))) onDeleted();
                }}
              />
            </>
          )}
          <ErrorText message={error} />
        </div>
      </div>
      <div className="scroll-panel flex min-w-0 flex-col gap-2">
        {item.level === 'year' || item.level === 'quarter' ? (
          <>
            <span className="text-xs text-muted">
              {t('goals.krs')} · {Math.round(item.progress)}%
            </span>
            {item.keyResults.length === 0 && (
              <span className="text-sm text-muted">{t('goals.krs.empty')}</span>
            )}
            {item.keyResults.map((k) => (
              <KrBar key={k.id} k={k} value={item.krProgress[k.id] ?? 0} level={item.level} />
            ))}
          </>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={item.done}
              disabled={!item.mine || busy}
              onChange={(e) => void attempt(() => api.setPlanDone(item.id, e.target.checked))}
            />
            {t('goals.done')} · {Math.round(item.progress)}%
          </label>
        )}
      </div>
    </section>
  );
}

function KrBar({ k, value, level }: { k: KeyResult; value: number; level: PlanLevel }) {
  const v = Math.round(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{k.title}</span>
        <span className="shrink-0 text-xs text-muted">
          {k.start} → {k.target} {k.unit} · {t('goals.kr.current', { value: k.current })} · {v}%
        </span>
      </div>
      <ProgressBar size="sm" value={v / 100} label={k.title} barClassName={LEVEL_BG[level]} />
    </div>
  );
}

// ── 編輯對話框 ───────────────────────────────────────────────

function GoalEditor({
  initial,
  items,
  teams,
  onClose,
  onSaved,
}: {
  initial: PlanInput;
  items: PlanView[];
  teams: TeamView[];
  onClose: () => void;
  onSaved: (id: string, level: PlanLevel) => void;
}) {
  const [v, setV] = useState<PlanInput>(initial);
  const { busy, error, attempt } = useAction();
  const set = (patch: Partial<PlanInput>) => setV((x) => ({ ...x, ...patch }));
  const okr = v.level === 'year' || v.level === 'quarter';
  const parents = parentOptions(items, v.level, v.period).filter((p) => p.id !== v.id);
  const parent = parents.find((p) => p.id === v.parentId);
  const visValue = v.visibility.kind === 'team' ? `team:${v.visibility.team}` : v.visibility.kind;
  const setKr = (i: number, patch: Partial<KeyResult>) =>
    set({ keyResults: v.keyResults.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const save = async () => {
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
      title={v.id ? t('goals.edit') : t('goals.new')}
      onClose={onClose}
      onSubmit={() => void save()}
    >
      <Field label={t('goals.field.title')}>
        <TextInput
          autoFocus
          required
          maxLength={200}
          value={v.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('goals.field.level')}>
          <Select
            value={v.level}
            disabled={Boolean(v.id)}
            onChange={(e) => {
              const level = e.target.value as PlanLevel;
              set({ level, period: periodsFromAny(v.period, v.level)[level], parentId: null });
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {levelName(l)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('goals.field.period')}>
          <TextInput
            value={v.period}
            onChange={(e) => set({ period: e.target.value.trim(), parentId: null })}
            placeholder={PERIOD_HINT[v.level]}
            className="font-mono"
          />
        </Field>
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
      <Field label={t('goals.field.visibility')}>
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
          <legend className="mb-1 text-xs text-muted">{t('goals.krs')}</legend>
          {v.keyResults.map((k, i) => (
            <div
              key={k.id || i}
              className="flex flex-col gap-1 rounded-control border border-line p-2"
            >
              <div className="flex gap-2">
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
              <div className="grid grid-cols-4 gap-2 text-xs">
                {(['start', 'target', 'current'] as const).map((f) => (
                  <label key={f} className="flex flex-col gap-0.5">
                    <span className="text-muted">
                      {t(
                        (f === 'current'
                          ? 'goals.kr.current.label'
                          : `goals.kr.${f}`) as MessageKey,
                      )}
                    </span>
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
                  </label>
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
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={!k.manual}
                  onChange={(e) => setKr(i, { manual: !e.target.checked })}
                />
                {t('goals.kr.auto')}
              </label>
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
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={v.progressOverride !== null}
          onChange={(e) => set({ progressOverride: e.target.checked ? 0 : null })}
        />
        {t('goals.field.override')}
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
      </label>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={busy || !v.title.trim()}>
          {t('goals.save')}
        </Button>
      </div>
    </Dialog>
  );
}

const PERIOD_HINT: Record<PlanLevel, string> = {
  year: '2026',
  quarter: '2026-Q4',
  month: '2026-11',
  week: '2026-W45',
  day: '2026-11-08',
};

/** 換層級時依原期間推算新層級的期間（取原期間的第一天）。 */
function periodsFromAny(period: string, level: PlanLevel): Periods {
  const p = period.split('-');
  const y = Number(p[0]) || new Date().getFullYear();
  let m = 1;
  let d = 1;
  if (level === 'quarter') m = (Number(p[1]?.slice(1)) - 1) * 3 + 1 || 1;
  if (level === 'month' || level === 'day') m = Number(p[1]) || 1;
  if (level === 'day') d = Number(p[2]) || 1;
  if (level === 'week') {
    const w = Number(p[1]?.slice(1)) || 1;
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const mon = new Date(Date.UTC(y, 0, 4 - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7));
    return periodsAt(mon.getTime() + 12 * 3_600_000, 'UTC');
  }
  return periodsAt(Date.UTC(y, m - 1, d, 12), 'UTC');
}
