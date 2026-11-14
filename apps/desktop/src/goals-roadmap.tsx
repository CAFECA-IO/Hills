/**
 * 目標時間軸（ui-spec「工作 › 目標的引導流程」v0.46，D67；設計畫布 G5）：只看不改。
 * 橫軸是期間、縱向是上一層目標；點卡片開詳情（放大、拆到下一層、調整…），按兩下或 Enter 放大。
 * 新增與修改都走引導流程（goals-flows.tsx）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type MemberView,
  type PlanLevel,
  type PlanView,
  type Task,
  type TeamView,
} from './api';
import { LEVEL_BG, LEVEL_TEXT, levelName } from './goals-editor';
import { AdjustFlow, BreakdownFlow, planPeriod } from './goals-flows';
import type { ToastState } from './goals-guided';
import { periodsAt, periodsOfYmd } from './goals-utils';
import { useLoad } from './hooks';
import { t, type MessageKey } from './i18n';
import { PageHead } from './layout';
import {
  CHILD,
  columns,
  packRows,
  shift,
  spanOf,
  startOf,
  ymdOf,
  zoomPeriod,
  type Col,
  type Ymd,
  type Zoom,
} from './roadmap-utils';
import {
  Button,
  EmptyState,
  ErrorText,
  IconButton,
  Popover,
  Pressable,
  ProgressBar,
  SegmentedControl,
  Switch,
  Toast,
} from './ui';

export interface GoalsProps {
  members: MemberView[];
  teams: TeamView[];
  tasks: Task[];
  focusId: string | null;
  timezone: string;
}

export type RoadmapProps = GoalsProps & {
  headExtra?: ReactNode;
  /** 「規劃或調整目標」：回到「我的位置」的四個入口 */
  onPlan?: () => void;
};

/** 列：上一層目標；`loose` 為「沒有連到上一層」。 */
interface Lane {
  key: string;
  title: string;
  progress: number | null;
  loose: boolean;
  owner: PlanView | null;
}

interface Card {
  key: string;
  title: string;
  progress: number;
  level: PlanLevel;
  span: [number, number];
  plan: PlanView;
  owner?: string;
}

type ViewZoom = Exclude<Zoom, 'week'>;

export function GoalsRoadmap({ members, teams, tasks, timezone, headExtra, onPlan }: RoadmapProps) {
  const [mineOnly, setMineOnly] = useState(true);
  const plans = useLoad(() => api.plans(mineOnly), ['doc', 'org', 'roster']);
  const reload = plans.reload;
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineOnly]);
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone);
  const [zoom, setZoom] = useState<ViewZoom>('quarter');
  const [at, setAt] = useState<Ymd>(() => ymdOf(today));
  const [detail, setDetail] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<PlanView | null>(null);
  const [breakdown, setBreakdown] = useState<PlanView | null>(null);
  const [toast, setToast] = useState<(ToastState & { key: number }) | null>(null);
  const items = useMemo(() => plans.data ?? [], [plans.data]);
  const p = periodsOfYmd(at.y, at.m, at.d);
  const cols = columns(zoom, p);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me) || x.leads.includes(me));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  const { lanes, cards } = useMemo(
    () => build(zoom, p, cols, items, nameOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, p.day, items],
  );
  const done = (s: ToastState) => {
    setToast({ ...s, key: Date.now() });
    setAdjusting(null);
    setBreakdown(null);
    reload();
  };
  const zoomIn = (plan: PlanView) => {
    const next: Partial<Record<PlanLevel, ViewZoom>> = {
      year: 'year',
      quarter: 'quarter',
      month: 'month',
    };
    const z = next[plan.level];
    if (!z) return;
    setDetail(null);
    setAt(startOf(plan.level, plan.period));
    setZoom(z === zoom && zoom !== 'month' ? (zoom === 'year' ? 'quarter' : 'month') : z);
  };

  if (breakdown) {
    return (
      <BreakdownFlow
        items={items}
        tasks={tasks}
        me={me}
        myTeams={myTeams}
        timezone={timezone}
        periods={today}
        parent={breakdown}
        onCancel={() => setBreakdown(null)}
        onDone={done}
      />
    );
  }

  const label = planPeriod(zoom, zoomPeriod(zoom, p));
  const isToday = zoomPeriod(zoom, p) === zoomPeriod(zoom, today);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead title={t('goals.title')} actions={headExtra} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SegmentedControl
          label={t('roadmap.zoom')}
          options={(['year', 'quarter', 'month'] as const).map((z) => ({
            value: z,
            label: levelName(z),
          }))}
          value={zoom}
          onChange={(z) => {
            setZoom(z);
            setDetail(null);
          }}
        />
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
        <Switch
          className="h-9 rounded-full bg-surface px-3 shadow-sm"
          label={t('goals.mineOnly')}
          checked={mineOnly}
          onChange={setMineOnly}
        />
        <span className="flex-1" />
        {onPlan && <Button onClick={onPlan}>{t('roadmap.plan')}</Button>}
      </div>
      <ErrorText message={plans.error} />

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-surface shadow-sm">
        <div
          className="grid border-b border-line"
          style={{ gridTemplateColumns: `200px repeat(${cols.length}, minmax(0, 1fr))` }}
        >
          <span className="row-span-2 px-4 py-2 text-xs font-bold text-muted">
            {t('roadmap.lanes.parent', { level: levelName(zoom) })}
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
            const isNow = c.key === today.month || c.key === today.week || c.key === today.quarter;
            return (
              <span
                key={c.key}
                className={`border-l border-line px-1.5 py-1 text-2xs ${isNow ? 'font-bold text-primary' : 'text-muted'}`}
                style={{ gridColumn: i + 2, gridRow: 2 }}
              >
                {c.label}
                {isNow && ` · ${t('goals.today')}`}
              </span>
            );
          })}
        </div>
        <div className="scroll-panel min-h-0 flex-1">
          {lanes.length === 0 && (
            <EmptyState
              art="goals"
              loading={plans.data === null}
              skeleton="lines"
              action={
                onPlan ? (
                  <Button variant="secondary" onClick={onPlan}>
                    {t('roadmap.planGuided')}
                  </Button>
                ) : undefined
              }
            >
              {t('roadmap.emptyPeriod', { period: label })}
            </EmptyState>
          )}
          {lanes.map((lane) => {
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
                  gridTemplateColumns: `200px repeat(${cols.length}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rowCount}, minmax(56px, auto))`,
                }}
              >
                <div
                  className={`flex flex-col gap-1 px-4 py-2.5 ${lane.loose ? 'bg-bg' : ''}`}
                  style={{ gridRow: `1 / span ${rowCount}` }}
                >
                  <span className={`text-sm font-bold ${lane.loose ? 'text-muted' : ''}`}>
                    {lane.title}
                  </span>
                  {lane.progress !== null && (
                    <span className="flex items-center gap-2">
                      <ProgressBar
                        size="sm"
                        className="flex-1"
                        value={lane.progress / 100}
                        label={lane.title}
                      />
                      <span className="text-xs">{Math.round(lane.progress)}%</span>
                    </span>
                  )}
                </div>
                {cols.map((c, ci) => (
                  <div
                    key={c.key}
                    className="border-l border-line"
                    style={{ gridColumn: ci + 2, gridRow: `1 / span ${rowCount}` }}
                  />
                ))}
                {laneCards.map((c, i) => (
                  <div
                    key={c.key}
                    className={`relative px-1 py-1 ${detail === c.key ? 'z-30' : 'z-10'}`}
                    style={{
                      gridColumn: `${c.span[0] + 2} / ${c.span[1] + 3}`,
                      gridRow: (rows[i] ?? 0) + 1,
                    }}
                  >
                    <CardButton
                      card={c}
                      open={detail === c.key}
                      onToggle={() => setDetail(detail === c.key ? null : c.key)}
                      onClose={() => setDetail(null)}
                      onZoom={() => zoomIn(c.plan)}
                      onBreakdown={
                        c.plan.mine && c.plan.level !== 'week'
                          ? () => {
                              setDetail(null);
                              setBreakdown(c.plan);
                            }
                          : undefined
                      }
                      onAdjust={
                        c.plan.mine
                          ? () => {
                              setDetail(null);
                              setAdjusting(c.plan);
                            }
                          : undefined
                      }
                      parentTitle={items.find((x) => x.id === c.plan.parentId)?.title ?? null}
                      tasks={tasks.filter((x) => x.planItemId === c.plan.id)}
                      children={items.filter((x) => x.parentId === c.plan.id)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          {t('roadmap.hint.view')}
        </p>
      </section>

      {adjusting && (
        <AdjustFlow
          item={adjusting}
          items={items}
          tasks={tasks}
          onClose={() => setAdjusting(null)}
          onDone={done}
          onEditText={() => {
            setAdjusting(null);
            onPlan?.();
          }}
        />
      )}
      {toast && <Toast key={toast.key} message={toast.message} onClose={() => setToast(null)} />}
    </div>
  );
}

/** 時間軸上的一張卡：點擊開詳情、按兩下或 Enter 放大。 */
function CardButton({
  card: c,
  open,
  onToggle,
  onClose,
  onZoom,
  onBreakdown,
  onAdjust,
  parentTitle,
  tasks,
  children,
}: {
  card: Card;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onZoom: () => void;
  onBreakdown?: () => void;
  onAdjust?: () => void;
  parentTitle: string | null;
  tasks: Task[];
  children: PlanView[];
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const doneTasks = tasks.filter((x) => x.status === 'done').length;
  return (
    <>
      <Pressable
        ref={ref}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 text-left text-sm shadow-sm hover:border-primary"
        onClick={onToggle}
        onDoubleClick={onZoom}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onZoom();
          }
        }}
        aria-roledescription={t('roadmap.card')}
      >
        <span
          aria-hidden="true"
          className={`h-8 w-1 shrink-0 self-stretch rounded-full ${LEVEL_BG[c.level]}`}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-2 font-semibold break-all">{c.title}</span>
          <span className="flex items-center gap-1.5 text-xs">
            {c.owner && <span className="truncate text-muted">{c.owner}</span>}
            {c.plan.review && (
              <span className="text-muted">
                {t(`review.o.${c.plan.review.outcome}` as MessageKey)}
              </span>
            )}
            <span className={`ml-auto shrink-0 font-bold ${LEVEL_TEXT[c.level]}`}>
              {Math.round(c.progress)}%
            </span>
          </span>
        </span>
      </Pressable>
      {open && (
        <Popover
          label={c.title}
          onClose={onClose}
          anchorRef={ref}
          className="absolute top-full left-1 z-30 mt-1 flex w-80 flex-col"
        >
          <div className="flex flex-col gap-2 p-4">
            <span className="text-xs text-muted">
              {levelName(c.level)} · {planPeriod(c.level, c.plan.period)}
              {parentTitle ? ` · ${t('guide.forTitle', { title: parentTitle })}` : ''}
            </span>
            <span className="text-base font-bold">{c.title}</span>
            <span className="flex items-center gap-2">
              <ProgressBar size="sm" className="flex-1" value={c.progress / 100} label={c.title} />
              <span className="text-sm">{Math.round(c.progress)}%</span>
            </span>
            <span className="text-xs text-muted">
              {t('roadmap.detail.summary', {
                children: children.length,
                done: doneTasks,
                total: tasks.length,
              })}
            </span>
            {c.plan.review?.note && (
              <span className="text-xs">
                {t('roadmap.detail.note', { note: c.plan.review.note })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            {c.level !== 'week' && (
              <Button size="sm" variant="secondary" onClick={onZoom}>
                {t('roadmap.detail.zoom')}
              </Button>
            )}
            {onBreakdown && (
              <Button size="sm" variant="secondary" onClick={onBreakdown}>
                {t('roadmap.detail.breakdown')}
              </Button>
            )}
            {onAdjust && (
              <Button size="sm" onClick={onAdjust}>
                {t('roadmap.detail.adjust')}
              </Button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
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

/** 依縮放建立列與卡片：列 = 這一期的目標，卡片 = 它們的下一層（D67）。 */
function build(
  zoom: ViewZoom,
  p: ReturnType<typeof periodsOfYmd>,
  cols: Col[],
  items: PlanView[],
  nameOf: (id: string) => string,
): { lanes: Lane[]; cards: Card[] } {
  const lanes: Lane[] = [];
  const cards: Card[] = [];
  const period = zoomPeriod(zoom, p);
  const child = CHILD[zoom];
  const parents = items.filter((i) => i.level === zoom && i.period === period);
  const kids = items.filter((i) => i.level === child && spanOf(zoom, i.period, cols));
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
      owner: g.mine ? undefined : nameOf(g.owner),
    });
  };
  for (const g of parents) {
    const lane: Lane = {
      key: g.id,
      title: g.mine ? g.title : `${g.title}（${nameOf(g.owner)}）`,
      progress: g.progress,
      loose: false,
      owner: g,
    };
    lanes.push(lane);
    kids.filter((k) => k.parentId === g.id).forEach((k) => addCard(lane, k));
  }
  const rest = kids.filter((k) => !parents.some((g) => g.id === k.parentId));
  if (rest.length) {
    const lane: Lane = {
      key: '__loose',
      title: t(`roadmap.loose.${child}` as MessageKey),
      progress: null,
      loose: true,
      owner: null,
    };
    lanes.push(lane);
    rest.forEach((k) => addCard(lane, k));
  }
  return { lanes, cards };
}
