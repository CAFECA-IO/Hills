/**
 * 目標路線圖（ui-spec「目標 → 進階檢視：路線圖」v0.21，D47 第 3 批；設計畫布 B1–B4）：
 * 橫軸是時間、縱向是泳道；點空格子新增、拖曳或 Alt + 方向鍵移動、點兩下或 Enter 放大、一次拆解。
 */
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  api,
  isPrivateTask,
  PRIVATE_TEAM,
  taskProgress,
  type KeyResult,
  type MemberView,
  type PlanInput,
  type PlanLevel,
  type PlanView,
  type Task,
  type TeamView,
  type Visibility,
} from './api';
import { GoalEditor, LEVEL_BG, LEVEL_TEXT, LockIcon, levelName, toInput } from './goals-editor';
import { taskInput } from './goals-guided';
import { childSlots, slotRange } from './goals-guided-utils';
import { periodsAt, periodsOfYmd } from './goals-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  CHILD,
  columns,
  dayCol,
  dueOfCol,
  packRows,
  periodOfCol,
  shift,
  spanOf,
  startOf,
  ymdOf,
  zoomPeriod,
  type Col,
  type Ymd,
  type Zoom,
} from './roadmap-utils';
import { TaskDialog, type TaskDraft } from './tasks';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorText,
  IconButton,
  Pressable,
  SegmentedControl,
  Select,
  TextInput,
  useAction,
} from './ui';

export interface GoalsProps {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
}

export type RoadmapProps = GoalsProps & { headExtra?: ReactNode };

/** 泳道：上層目標或關鍵結果；`id === null` 為「未連結」。 */
interface Lane {
  key: string;
  title: string;
  progress: number | null;
  /** 新增 / 移到這條泳道時的上層與關鍵結果 */
  parentId: string | null;
  krRef: string | null;
  /** 週縮放：任務的週目標 */
  planItemId: string | null;
  loose: boolean;
  owner: PlanView | null;
}

interface Card {
  key: string;
  title: string;
  progress: number;
  level: PlanLevel | 'task';
  span: [number, number];
  plan?: PlanView;
  task?: Task;
  movable: boolean;
  owner?: string;
}

const MAX_PER_DAY = 3;

export function GoalsRoadmap({ members, teams, tasks, timezone, headExtra }: RoadmapProps) {
  const [mineOnly, setMineOnly] = useState(true);
  const plans = useLoad(() => api.plans(mineOnly), ['doc', 'org', 'roster']);
  const reload = plans.reload;
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineOnly]);
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone);
  const [zoom, setZoom] = useState<Zoom>('quarter');
  const [at, setAt] = useState<Ymd>(() => ymdOf(today));
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanInput | null>(null);
  const [taskEditing, setTaskEditing] = useState<{ task: Task | null; draft?: TaskDraft } | null>(
    null,
  );
  const [breakdown, setBreakdown] = useState(false);
  const [draft, setDraft] = useState<{ lane: string; col: string } | null>(null);
  const { error, attempt } = useAction();
  const items = useMemo(() => plans.data ?? [], [plans.data]);
  const p = periodsOfYmd(at.y, at.m, at.d);
  const cols = columns(zoom, p);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me) || x.leads.includes(me));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  const defaultVis: Visibility = myTeams[0]
    ? { kind: 'team', team: myTeams[0].id }
    : { kind: 'org' };

  // ── 焦點（季縮放：選一個季目標；其他縮放用於一次拆解）──
  const levelGoals = (level: PlanLevel, period: string) =>
    items.filter((i) => i.level === level && i.period === period);
  const quarterGoals = levelGoals('quarter', p.quarter);
  const focusGoal: PlanView | null =
    zoom === 'quarter'
      ? (quarterGoals.find((g) => g.id === focus) ?? quarterGoals[0] ?? null)
      : zoom === 'year'
        ? (levelGoals('year', p.year).find((g) => g.id === focus) ??
          levelGoals('year', p.year)[0] ??
          null)
        : zoom === 'month'
          ? (levelGoals('month', p.month).find((g) => g.id === focus) ??
            levelGoals('month', p.month)[0] ??
            null)
          : null;

  // ── 泳道與卡片 ──
  const { lanes, cards } = useMemo(
    () => build(zoom, p, cols, items, tasks, focusGoal, me, nameOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, p.day, items, tasks, focusGoal?.id, me],
  );

  const open = (c: Card) => {
    if (c.task) setTaskEditing({ task: c.task });
    else if (c.plan) setEditing(toInput(c.plan));
  };
  const zoomIn = (c: Card) => {
    if (!c.plan) {
      if (c.task) setTaskEditing({ task: c.task });
      return;
    }
    const next: Record<PlanLevel, Zoom | null> = {
      year: 'year',
      quarter: 'quarter',
      month: 'month',
      week: 'week',
      day: null,
    };
    const z = next[c.plan.level];
    if (!z) return;
    setAt(startOf(c.plan.level, c.plan.period));
    setZoom(z);
    setFocus(c.plan.id);
  };

  const create = async (lane: Lane, col: string, title: string) => {
    const text = title.trim();
    if (!text) return;
    await attempt(async () => {
      if (zoom === 'week') {
        const team = myTeams[0]?.id ?? PRIVATE_TEAM;
        await api.createTask(team, {
          title: text,
          assignee: me,
          dueAt: dueOfCol(col),
          steps: [],
          planItemId: lane.planItemId,
        });
        return;
      }
      await api.savePlan({
        level: CHILD[zoom],
        period: periodOfCol(zoom, col),
        title: text,
        parentId: lane.parentId,
        krRef: lane.krRef,
        done: false,
        progressOverride: null,
        keyResults: [],
        alignedGoalId: CHILD[zoom] === 'quarter' ? (lane.owner?.alignedGoalId ?? null) : null,
        criteria: [],
        helps: [],
        visibility: lane.owner?.mine ? lane.owner.visibility : defaultVis,
      });
    });
    setDraft(null);
    reload();
  };

  const move = async (c: Card, lane: Lane, col: string) => {
    if (!c.movable) return;
    await attempt(async () => {
      if (c.task) {
        await api.updateTask(
          c.task.team,
          c.task.id,
          taskInput(c.task, { dueAt: dueOfCol(col), planItemId: lane.planItemId }),
        );
        return;
      }
      if (c.plan && zoom !== 'week') {
        await api.savePlan({
          ...toInput(c.plan),
          period: periodOfCol(zoom, col),
          parentId: lane.parentId,
          krRef: lane.krRef,
        });
      }
    });
    reload();
  };

  /** Alt + 方向鍵：移到前 / 後一欄、上 / 下一條泳道（拖曳的鍵盤替代）。 */
  const onCardKey = (e: KeyboardEvent, c: Card, laneIdx: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      zoomIn(c);
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      open(c);
      return;
    }
    if (!e.altKey) return;
    const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dl = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dc && !dl) return;
    e.preventDefault();
    const lane = lanes[Math.max(0, Math.min(lanes.length - 1, laneIdx + dl))];
    if (!lane) return;
    // 往右跳到下一個子期間的第一欄（季縮放的月目標跨好幾週）
    let idx = dc > 0 ? c.span[1] + 1 : dc < 0 ? c.span[0] - 1 : c.span[0];
    idx = Math.max(0, Math.min(cols.length - 1, idx));
    const col = cols[idx];
    if (col) void move(c, lane, col.key);
  };

  const label =
    zoom === 'year'
      ? p.year
      : zoom === 'quarter'
        ? `${p.year} ${p.quarter.slice(5)}`
        : zoom === 'month'
          ? t('roadmap.monthLabel', { y: p.year, m: Number(p.month.slice(5)) })
          : (() => {
              const r = slotRange({ level: 'week', period: p.week });
              return `${r.from} – ${r.to}`;
            })();
  const isToday = zoomPeriod(zoom, p) === zoomPeriod(zoom, today);
  const canBreakdown = zoom !== 'week' && focusGoal?.mine;
  const perDay = (key: string) =>
    cards.filter((c) => c.task && c.task.status !== 'done' && cols[c.span[0]]?.key === key).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead
        title={t('goals.title')}
        subtitle={t(`roadmap.subtitle.${zoom}`)}
        actions={
          <>
            <SegmentedControl
              label={t('roadmap.zoom')}
              options={(['year', 'quarter', 'month', 'week'] as const).map((z) => ({
                value: z,
                label: levelName(z),
              }))}
              value={zoom}
              onChange={(z) => {
                setZoom(z);
                setFocus(null);
                setDraft(null);
              }}
            />
            {headExtra}
            <Checkbox
              className="h-9 rounded-full bg-surface px-3 shadow-sm"
              label={t('goals.mineOnly')}
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            <Button
              onClick={() =>
                setEditing({
                  id: null,
                  level: zoom === 'week' ? 'week' : zoom,
                  period: zoomPeriod(zoom, p),
                  title: '',
                  parentId: null,
                  krRef: null,
                  done: false,
                  progressOverride: null,
                  keyResults: [],
                  visibility: defaultVis,
                })
              }
            >
              {t('goals.new')}
            </Button>
          </>
        }
      />
      <div className="flex items-center gap-2 text-sm">
        <IconButton
          variant="secondary"
          size="sm"
          label={t('roadmap.prev')}
          onClick={() => setAt((a) => shift(zoom, a, -1))}
        >
          ◀
        </IconButton>
        <span className="min-w-28 text-center font-bold">{label}</span>
        <IconButton
          variant="secondary"
          size="sm"
          label={t('roadmap.next')}
          onClick={() => setAt((a) => shift(zoom, a, 1))}
        >
          ▶
        </IconButton>
        <Button
          variant="secondary"
          size="sm"
          disabled={isToday}
          onClick={() => setAt(ymdOf(today))}
        >
          {t('goals.today')}
        </Button>
        {zoom !== 'week' && (
          <>
            <span className="ml-3 text-muted">{t('roadmap.focus')}</span>
            <Select
              aria-label={t('roadmap.focus')}
              className="w-56"
              size="sm"
              value={focusGoal?.id ?? ''}
              onChange={(e) => setFocus(e.target.value || null)}
            >
              {focusOptions(zoom, items, p).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                  {g.mine ? '' : `（${nameOf(g.owner)}）`}
                </option>
              ))}
              {focusOptions(zoom, items, p).length === 0 && (
                <option value="">{t('roadmap.noFocus')}</option>
              )}
            </Select>
          </>
        )}
        {canBreakdown && (
          <Button variant="soft" size="sm" className="ml-auto" onClick={() => setBreakdown(true)}>
            {t('roadmap.breakdown')}
          </Button>
        )}
        <ErrorText message={plans.error ?? error} />
      </div>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-surface shadow-sm">
        <div
          className="grid border-b border-line"
          style={{ gridTemplateColumns: `160px repeat(${cols.length}, minmax(0, 1fr))` }}
        >
          <span className="row-span-2 px-4 py-2 text-xs font-bold text-muted">
            {zoom === 'quarter' ? t('roadmap.lanes.kr') : t('roadmap.lanes.goal')}
          </span>
          {groups(cols).map((g) => (
            <span
              key={g.key}
              className="border-l border-line px-2 py-1 text-xs font-bold text-muted"
              style={{ gridColumn: `${g.start + 2} / ${g.end + 3}` }}
            >
              {groupLabel(zoom, g.key)}
            </span>
          ))}
          {cols.map((c, i) => {
            const isNow = c.key === today.month || c.key === today.week || c.key === today.day;
            const over = zoom === 'week' && c.key !== 'none' && perDay(c.key) > MAX_PER_DAY;
            return (
              <span
                key={c.key}
                className={`border-l border-line px-1.5 py-1 text-2xs ${isNow ? 'font-bold text-primary' : 'text-muted'}`}
                style={{ gridColumn: i + 2, gridRow: 2 }}
              >
                {c.key === 'none' ? t('roadmap.noDate') : c.label}
                {isNow && ` · ${t('goals.today')}`}
                {over && <span className="ml-1 font-bold text-warning">{t('roadmap.over')}</span>}
                {zoom === 'week' && c.key !== 'none' && !over && (
                  <span className="ml-1">{t('roadmap.count', { n: perDay(c.key) })}</span>
                )}
              </span>
            );
          })}
        </div>
        <div className="scroll-panel min-h-0 flex-1">
          {lanes.length === 0 && (
            <EmptyState>
              {zoom === 'quarter' && quarterGoals.length === 0
                ? t('roadmap.emptyQuarter')
                : t('roadmap.empty')}
            </EmptyState>
          )}
          {lanes.map((lane, li) => {
            const laneCards = cards
              .filter((c) => c.key.startsWith(`${lane.key}|`))
              .sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
            const rows = packRows(laneCards.map((c) => c.span));
            const rowCount = Math.max(1, ...rows.map((r) => r + 1));
            return (
              <div
                key={lane.key}
                className="grid border-b border-line"
                style={{
                  gridTemplateColumns: `160px repeat(${cols.length}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rowCount + 1}, minmax(36px, auto))`,
                }}
              >
                <div
                  className={`flex flex-col gap-0.5 px-4 py-2 ${lane.loose ? 'bg-bg' : ''}`}
                  style={{ gridRow: `1 / span ${rowCount + 1}` }}
                >
                  <span className={`truncate text-sm font-bold ${lane.loose ? 'text-muted' : ''}`}>
                    {lane.title}
                  </span>
                  {lane.progress !== null && (
                    <span className="text-xs text-muted">
                      {t('drift.progress', { pct: Math.round(lane.progress) })}
                    </span>
                  )}
                  {!lane.loose && laneCards.length === 0 && (
                    <span className="text-xs font-bold text-warning">
                      ⚠ {t('roadmap.noChildren')}
                    </span>
                  )}
                </div>
                {cols.map((c, ci) => {
                  const editingHere = draft?.lane === lane.key && draft.col === c.key;
                  return (
                    <div
                      key={c.key}
                      className="border-l border-line"
                      style={{ gridColumn: ci + 2, gridRow: `1 / span ${rowCount + 1}` }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e: DragEvent) => {
                        e.preventDefault();
                        const key = e.dataTransfer.getData('text/plain');
                        const card = cards.find((x) => x.key === key);
                        if (card) void move(card, lane, c.key);
                      }}
                    >
                      {editingHere ? (
                        <TextInput
                          autoFocus
                          size="sm"
                          aria-label={t('roadmap.newIn', {
                            lane: lane.title,
                            col: c.label || t('roadmap.noDate'),
                          })}
                          placeholder={
                            zoom === 'week'
                              ? t('roadmap.newTask')
                              : t('roadmap.newGoal', { level: levelName(CHILD[zoom]) })
                          }
                          className="m-1 w-auto"
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setDraft(null);
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                              void create(lane, c.key, (e.target as HTMLInputElement).value);
                            }
                          }}
                          onBlur={() => setDraft(null)}
                        />
                      ) : (
                        <Pressable
                          aria-label={t('roadmap.addIn', {
                            lane: lane.title,
                            col: c.label || t('roadmap.noDate'),
                          })}
                          className="flex h-full min-h-9 w-full items-end justify-center pb-1 text-muted opacity-0 hover:bg-bg hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => setDraft({ lane: lane.key, col: c.key })}
                        >
                          ＋
                        </Pressable>
                      )}
                    </div>
                  );
                })}
                {laneCards.map((c, i) => (
                  <div
                    key={c.key}
                    className="z-10 px-1 py-1"
                    style={{
                      gridColumn: `${c.span[0] + 2} / ${c.span[1] + 3}`,
                      gridRow: (rows[i] ?? 0) + 1,
                    }}
                    draggable={c.movable}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', c.key)}
                  >
                    <Pressable
                      className={`flex w-full items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 text-left text-sm shadow-sm hover:border-primary ${c.movable ? 'cursor-grab' : ''}`}
                      onClick={() => open(c)}
                      onDoubleClick={() => zoomIn(c)}
                      onKeyDown={(e) => onCardKey(e, c, li)}
                      aria-roledescription={t('roadmap.card')}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-8 w-1 shrink-0 self-stretch rounded-full ${c.level === 'task' ? 'bg-level-day' : LEVEL_BG[c.level]}`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="line-clamp-2 font-semibold break-all">
                          {c.task && isPrivateTask(c.task) && (
                            <span className="mr-1 inline-flex text-muted">
                              <LockIcon />
                            </span>
                          )}
                          {c.title}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs">
                          {c.owner && <span className="truncate text-muted">{c.owner}</span>}
                          <span
                            className={`ml-auto shrink-0 font-bold ${c.level === 'task' ? 'text-muted' : LEVEL_TEXT[c.level]}`}
                          >
                            {c.task
                              ? `${c.task.steps.filter((s) => s.done).length}/${c.task.steps.length || 1}`
                              : `${Math.round(c.progress)}%`}
                          </span>
                        </span>
                      </span>
                    </Pressable>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          {t(`roadmap.hint.${zoom === 'week' ? 'week' : 'goal'}`)}
        </p>
      </section>

      {editing && (
        <GoalEditor
          initial={editing}
          items={items}
          teams={myTeams}
          anchor={p}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {taskEditing && (
        <TaskDialog
          task={taskEditing.task}
          draft={taskEditing.draft}
          teams={myTeams}
          members={members}
          timezone={timezone}
          onClose={() => setTaskEditing(null)}
          onSaved={() => reload()}
        />
      )}
      {breakdown && focusGoal && zoom !== 'week' && (
        <BreakdownDialog
          parent={focusGoal}
          items={items}
          onClose={() => setBreakdown(false)}
          onDone={() => {
            setBreakdown(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function focusOptions(
  zoom: Zoom,
  items: PlanView[],
  p: ReturnType<typeof periodsOfYmd>,
): PlanView[] {
  if (zoom === 'week') return [];
  const level: PlanLevel = zoom;
  const period = zoomPeriod(zoom, p);
  return items.filter((i) => i.level === level && i.period === period);
}

function groups(cols: Col[]): { key: string; start: number; end: number }[] {
  const out: { key: string; start: number; end: number }[] = [];
  cols.forEach((c, i) => {
    const last = out[out.length - 1];
    if (last && last.key === c.group) last.end = i;
    else out.push({ key: c.group, start: i, end: i });
  });
  return out;
}

function groupLabel(zoom: Zoom, key: string): string {
  if (zoom === 'year') return key;
  if (zoom === 'week') return '';
  return t('goals.period.monthN', { n: Number(key.slice(5)) });
}

/** 依縮放建立泳道與卡片（ui-spec 路線圖的泳道表）。 */
function build(
  zoom: Zoom,
  p: ReturnType<typeof periodsOfYmd>,
  cols: Col[],
  items: PlanView[],
  tasks: Task[],
  focus: PlanView | null,
  me: string,
  nameOf: (id: string) => string,
): { lanes: Lane[]; cards: Card[] } {
  const lanes: Lane[] = [];
  const cards: Card[] = [];
  const goalLane = (g: PlanView): Lane => ({
    key: g.id,
    title: g.mine ? g.title : `${g.title}（${nameOf(g.owner)}）`,
    progress: g.progress,
    parentId: g.mine ? g.id : null,
    krRef: null,
    planItemId: g.id,
    loose: false,
    owner: g,
  });
  const loose = (title: string): Lane => ({
    key: '__loose',
    title,
    progress: null,
    parentId: null,
    krRef: null,
    planItemId: null,
    loose: true,
    owner: null,
  });
  const addCard = (lane: Lane, g: PlanView) => {
    const span = spanOf(zoom, g.period, cols);
    if (!span) return;
    cards.push({
      key: `${lane.key}|${g.id}`,
      title: g.title,
      progress: g.progress,
      level: g.level,
      span,
      plan: g,
      movable: g.mine,
      owner: g.mine ? undefined : nameOf(g.owner),
    });
  };
  if (zoom === 'year' || zoom === 'month') {
    const level: PlanLevel = zoom;
    const period = zoom === 'year' ? p.year : p.month;
    const child = CHILD[zoom];
    const parents = items.filter((i) => i.level === level && i.period === period);
    const kids = items.filter((i) => i.level === child && spanOf(zoom, i.period, cols));
    for (const g of parents) {
      const lane = goalLane(g);
      lanes.push(lane);
      kids.filter((k) => k.parentId === g.id).forEach((k) => addCard(lane, k));
    }
    const rest = kids.filter((k) => !parents.some((g) => g.id === k.parentId));
    if (rest.length || parents.length) {
      const lane = loose(t(`roadmap.loose.${child}` as MessageKey));
      lanes.push(lane);
      rest.forEach((k) => addCard(lane, k));
    }
    return { lanes, cards };
  }
  if (zoom === 'quarter') {
    if (!focus) return { lanes, cards };
    const months = items.filter((i) => i.level === 'month' && spanOf(zoom, i.period, cols));
    const krLane = (k: KeyResult): Lane => ({
      key: `${focus.id}/${k.id}`,
      title: k.title,
      progress: focus.krProgress[k.id] ?? null,
      parentId: focus.mine ? focus.id : null,
      krRef: `${focus.id}/${k.id}`,
      planItemId: null,
      loose: false,
      owner: focus,
    });
    for (const k of focus.keyResults) {
      const lane = krLane(k);
      lanes.push(lane);
      months.filter((m) => m.krRef === lane.key).forEach((m) => addCard(lane, m));
    }
    const lane: Lane = {
      ...loose(t('roadmap.loose.month')),
      parentId: focus.mine ? focus.id : null,
      owner: focus,
    };
    lanes.push(lane);
    months
      .filter(
        (m) =>
          (m.parentId === focus.id &&
            !focus.keyResults.some((k) => m.krRef === `${focus.id}/${k.id}`)) ||
          !m.parentId,
      )
      .forEach((m) => addCard(lane, m));
    return { lanes, cards };
  }
  // 週：泳道 = 這一週的週目標，卡片 = 任務（依期限排到那一天）
  const weeks = items.filter((i) => i.level === 'week' && i.period === p.week);
  const visibleTask = (x: Task) =>
    x.assignee === me || x.steps.some((s) => s.assignee === me) || x.createdBy === me;
  const taskCard = (lane: Lane, x: Task) => {
    const key = dayCol(x.dueAt, cols);
    const i = cols.findIndex((c) => c.key === key);
    cards.push({
      key: `${lane.key}|${x.id}`,
      title: x.title,
      progress: taskProgress(x),
      level: 'task',
      span: [i, i],
      task: x,
      movable: true,
      owner: x.assignee && x.assignee !== me ? nameOf(x.assignee) : undefined,
    });
  };
  for (const g of weeks) {
    const lane = goalLane(g);
    lanes.push(lane);
    tasks.filter((x) => x.planItemId === g.id).forEach((x) => taskCard(lane, x));
  }
  const lane = loose(t('roadmap.loose.task'));
  lanes.push(lane);
  tasks
    .filter(
      (x) =>
        !x.planItemId && x.status !== 'done' && visibleTask(x) && dayCol(x.dueAt, cols) !== 'none',
    )
    .forEach((x) => taskCard(lane, x));
  return { lanes, cards };
}

// ── 一次拆解（B3） ─────────────────────────────────────────

interface Row {
  id: number;
  title: string;
  kr: string;
}

function BreakdownDialog({
  parent,
  items,
  onClose,
  onDone,
}: {
  parent: PlanView;
  items: PlanView[];
  onClose: () => void;
  onDone: () => void;
}) {
  const slots = childSlots(parent.level, parent.period);
  const child = slots[0]?.level ?? 'quarter';
  const withKr = parent.keyResults.length > 0 && (child === 'month' || child === 'week');
  const [rows, setRows] = useState<Record<string, Row[]>>(() =>
    Object.fromEntries(slots.map((s, i) => [s.period, [{ id: i * 100, title: '', kr: '' }]])),
  );
  const { busy, error, attempt } = useAction();
  const existing = (period: string) =>
    items.filter((i) => i.parentId === parent.id && i.period === period);
  const set = (period: string, list: Row[]) => setRows((r) => ({ ...r, [period]: list }));
  const filled = Object.entries(rows).flatMap(([period, list]) =>
    list.filter((r) => r.title.trim()).map((r) => ({ period, ...r })),
  );
  const coverage = parent.keyResults.map((k) => {
    const ref = `${parent.id}/${k.id}`;
    const n =
      items.filter((i) => i.parentId === parent.id && i.krRef === ref).length +
      filled.filter((f) => f.kr === ref).length;
    return { k, n };
  });
  const create = async () => {
    const ok = await attempt(async () => {
      for (const f of filled) {
        await api.savePlan({
          level: child,
          period: f.period,
          title: f.title.trim(),
          parentId: parent.id,
          krRef: f.kr || null,
          done: false,
          progressOverride: null,
          keyResults: [],
          alignedGoalId: child === 'quarter' ? parent.alignedGoalId : null,
          criteria: [],
          helps: [],
          visibility: parent.visibility,
        });
      }
    });
    if (ok) onDone();
  };
  return (
    <Dialog
      title={t('roadmap.bd.title', { title: parent.title, level: levelName(child) })}
      width="lg"
      onClose={onClose}
      onSubmit={create}
      dirty={filled.length > 0}
    >
      <p className="text-sm text-muted">{t('roadmap.bd.hint')}</p>
      {slots.map((s) => {
        const r = slotRange(s);
        const have = existing(s.period);
        const list = rows[s.period] ?? [];
        return (
          <div key={s.period} className="flex flex-col gap-1.5 border-t border-line pt-3">
            <div className="flex items-baseline gap-2">
              <span className="font-bold">
                {s.level === 'quarter'
                  ? t(`guide.slot.q${s.period.slice(-1)}` as MessageKey)
                  : s.level === 'month'
                    ? t('goals.period.monthN', { n: r.from })
                    : `${r.from} – ${r.to}`}
              </span>
              <span className="text-xs text-muted">
                {have.length ? t('roadmap.bd.have', { n: have.length }) : t('roadmap.bd.none')}
              </span>
            </div>
            {have.map((h) => (
              <div
                key={h.id}
                className="flex items-center gap-2 rounded-control bg-bg px-3 py-1.5 text-sm"
              >
                <span className="flex-1 truncate">{h.title}</span>
                {h.krRef && (
                  <span className="text-xs text-muted">
                    {parent.keyResults.find((k) => `${parent.id}/${k.id}` === h.krRef)?.title}
                  </span>
                )}
                <span className="text-xs font-bold">{Math.round(h.progress)}%</span>
              </div>
            ))}
            {list.map((row, i) => (
              <div key={row.id} className="flex items-center gap-2">
                <TextInput
                  size="sm"
                  className="flex-1"
                  aria-label={t('roadmap.bd.new', { period: r.from })}
                  placeholder={t('roadmap.newGoal', { level: levelName(child) })}
                  value={row.title}
                  onChange={(e) =>
                    set(
                      s.period,
                      list.map((x) => (x.id === row.id ? { ...x, title: e.target.value } : x)),
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (row.title.trim() && i === list.length - 1) {
                        set(s.period, [...list, { id: row.id + 1, title: '', kr: '' }]);
                      }
                    }
                  }}
                />
                {withKr && (
                  <Select
                    size="sm"
                    className="w-48"
                    aria-label={t('roadmap.bd.kr')}
                    value={row.kr}
                    onChange={(e) =>
                      set(
                        s.period,
                        list.map((x) => (x.id === row.id ? { ...x, kr: e.target.value } : x)),
                      )
                    }
                  >
                    <option value="">{t('goals.field.noKr')}</option>
                    {parent.keyResults.map((k) => (
                      <option key={k.id} value={`${parent.id}/${k.id}`}>
                        {k.title}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            ))}
          </div>
        );
      })}
      {withKr && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3 text-xs">
          <span className="font-bold">{t('roadmap.bd.coverage')}</span>
          {coverage.map(({ k, n }) => (
            <span key={k.id} className={n === 0 ? 'font-bold text-warning' : 'text-muted'}>
              {t('roadmap.bd.coverageItem', { kr: k.title, n })}
            </span>
          ))}
        </div>
      )}
      <ErrorText message={error} />
      <div className="flex items-center gap-2 pt-2">
        <span className="text-sm text-muted">
          {t('roadmap.bd.count', { n: filled.length, level: levelName(child) })}
        </span>
        <span className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={filled.length === 0}>
            {t('roadmap.bd.create', { n: filled.length, level: levelName(child) })}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}
