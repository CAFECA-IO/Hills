/** 首頁：焦點山（ui-spec「首頁」，D40）。 */
import { useMemo, useState } from 'react';
import {
  api,
  isPrivateTask,
  type ConvRow,
  type FocusView,
  type MemberView,
  type Overview,
  type Task,
} from './api';
import {
  SceneBadge,
  Cloud,
  Figure,
  House,
  NamePill,
  SkyGradient,
  SkyLight,
  StatusBadge,
  stateLabel,
  textWidth,
} from './figures';
import { AssignedCard } from './assign-inbox';
import { useSize } from './hooks';
import { formatClock, formatDate, t } from './i18n';
import { PageHead } from './layout';
import {
  backSoon,
  climberPosition,
  defersNotifications,
  groupByHill,
  layoutTrail,
  lookOf,
  MOUNTAIN,
  remainingFraction,
  SCENE,
  SUMMIT,
  type Checkpoint,
  type Hill,
} from './summit';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  IconButton,
  ListButton,
  Popover,
  SectionLabel,
  SegmentedControl,
  useAction,
} from './ui';

const v = (name: string) => `var(--hills-${name})`;

/** 山景最多放大倍數（ui-spec「版面」：字級不隨解析度放大） */
const MAX_SCENE_SCALE = 1.2;

interface Props {
  overview: Overview;
  tasks: Task[];
  focus: FocusView | null;
  convs: ConvRow[];
  onOpenConv: (conv: string) => void;
  onOpenTasks: () => void;
  now: number;
}

interface Picked {
  member: MemberView;
  x: number;
  y: number;
}

export function Home({ overview, tasks, focus, convs, onOpenConv, onOpenTasks, now }: Props) {
  const [view, setView] = useState<'scene' | 'list'>('scene');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [choosing, setChoosing] = useState(false);
  const clock = now;
  const me = overview.members.find((m) => m.isMe);
  const task = focus?.task ?? null;
  const nameOf = (id: string | null) => {
    const m = overview.members.find((x) => x.id === id);
    return m ? (m.isMe ? t('home.you') : m.name) : t('home.unassigned');
  };
  const meId = me?.id ?? '';
  const mine = tasks.filter(
    (x) =>
      x.status !== 'done' &&
      (x.assignee === meId || x.steps.some((s) => !s.done && s.assignee === meId)),
  );
  const [box, setBox] = useState<HTMLElement | null>(null);
  const size = useSize(box);
  // 依容器長寬比調整場景（ui-spec「版面」）：山居中、山丘平均分布；最多放大 1.2 倍，
  // 更大的容器改為顯示更多天空與更寬的山腳，字級不跟著放大
  const scale = size && size.h > 0 ? Math.min(size.h / SCENE.h, MAX_SCENE_SCALE) : 1;
  const sceneH = size ? Math.max(SCENE.h, Math.round(size.h / scale)) : SCENE.h;
  const sceneW = size ? Math.max(SCENE.w, Math.round(size.w / scale)) : SCENE.w;
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_280px] gap-3 wide:grid-cols-[minmax(0,1fr)_340px] wide:gap-4">
      <PageHead
        title={task ? t('home.title') : t('home.title.empty')}
        subtitle={
          task
            ? task.dueAt
              ? t('home.subtitle.due', { time: formatClock(task.dueAt), title: task.title })
              : t('home.subtitle', { title: task.title })
            : t('home.subtitle.empty')
        }
        actions={
          <>
            <Button
              variant="secondary"
              aria-expanded={choosing}
              onClick={() => setChoosing((c) => !c)}
            >
              {t('home.changeMountain')}
            </Button>
            <SegmentedControl
              label={t('home.title')}
              value={view}
              onChange={setView}
              options={(['scene', 'list'] as const).map((k) => ({
                value: k,
                label: t(k === 'scene' ? 'home.view.scene' : 'home.view.list'),
              }))}
            />
          </>
        }
      />
      <section
        ref={setBox}
        className="relative min-h-0 overflow-hidden rounded-card bg-sky-top shadow-sm"
      >
        {view === 'scene' ? (
          <>
            <Scene
              overview={overview}
              task={task}
              onPick={setPicked}
              nameOf={nameOf}
              now={clock}
              width={sceneW}
              height={sceneH}
            />
            {picked && (
              <MemberCard
                picked={picked}
                sceneW={sceneW}
                sceneH={sceneH}
                overview={overview}
                now={clock}
                onClose={() => setPicked(null)}
                onOpenConv={onOpenConv}
              />
            )}
          </>
        ) : (
          <div className="scroll-panel h-full">
            <SceneList overview={overview} task={task} nameOf={nameOf} now={clock} />
          </div>
        )}
        {choosing && (
          <div className="scroll-panel absolute top-3 left-3 z-20 max-h-[calc(100%-24px)] w-80 rounded-card shadow-lg">
            <ChooseMountain
              tasks={mine}
              current={task}
              manual={focus?.manual ?? false}
              onClose={() => setChoosing(false)}
              onOpenTasks={onOpenTasks}
            />
          </div>
        )}
      </section>
      <aside className="scroll-panel flex min-h-0 flex-col gap-3">
        <NextStepCard task={task} me={me} nameOf={nameOf} now={clock} onOpenTasks={onOpenTasks} />
        <AssignedCard tasks={tasks} members={overview.members} timezone={overview.timezone} />
        <UnreadCard convs={convs} overview={overview} onOpenConv={onOpenConv} />
        <BackSoonCard overview={overview} task={task} now={clock} />
      </aside>
    </div>
  );
}

// ── 場景 ────────────────────────────────────────────────────

function Scene({
  overview,
  task,
  onPick,
  nameOf,
  now,
  width,
  height,
}: {
  overview: Overview;
  task: Task | null;
  onPick: (p: Picked) => void;
  nameOf: (id: string | null) => string;
  now: number;
  /** 場景寬度（≥ SCENE.w）；山與山路置中 */
  width: number;
  /** 場景高度（≥ SCENE.h）；多出的部分是山頂上方的天空 */
  height: number;
}) {
  const top = SCENE.h - height;
  const me = overview.members.find((m) => m.isMe);
  const dx = (width - SCENE.w) / 2;
  const others = task ? overview.members.filter((m) => !m.isMe) : overview.members;
  const { hills, leave } = groupByHill(others, overview.offices);
  const trail = task ? layoutTrail(task.steps) : null;
  const climber = trail ? climberPosition(trail) : null;
  const nextAssignee = task?.steps.find((s) => !s.done)?.assignee ?? null;
  const pick = (member: MemberView, x: number, y: number) => onPick({ member, x, y });
  // 置中群組內的座標換回場景座標
  const pickCentered = (member: MemberView, x: number, y: number) =>
    onPick({ member, x: x + dx, y });
  const label = task
    ? t('home.scene.label', { title: task.title, done: doneCount(task), total: task.steps.length })
    : t('home.scene.label.empty');
  return (
    <svg
      viewBox={`0 ${top} ${width} ${height}`}
      preserveAspectRatio="xMidYMax meet"
      className="block h-full w-full"
      role="group"
      aria-label={label}
    >
      <SkyGradient id="home-sky" />
      <rect y={top} width={width} height={height} fill="url(#home-sky)" />
      <SkyLight x={width - 70} y={top + 70} now={now} />
      <g transform={`translate(${dx} 0)`}>
        <Cloud x={560} y={96} scale={0.55} />
        {leave.length > 0 && (
          <g>
            <Cloud x={128} y={132} scale={1.1} />
            {leave.slice(0, 3).map((m, i) => (
              <Person
                key={m.id}
                m={m}
                x={128 + (i - (Math.min(leave.length, 3) - 1) / 2) * 64}
                y={126}
                scale={0.75}
                note={
                  i === 0 && m.until
                    ? t('home.leaveUntil', { date: formatDate(m.until) })
                    : undefined
                }
                onPick={pickCentered}
              />
            ))}
          </g>
        )}
        <Mountain empty={!task} />
        {task && trail && (
          <>
            <TrailPath trail={trail} />
            <SummitFlag task={task} now={now} />
            {trail.points.map((p) => (
              <CheckpointMark key={p.step.id} p={p} nameOf={nameOf} />
            ))}
            {(trail.hiddenBefore > 0 || trail.hiddenAfter > 0) && (
              <text
                x={MOUNTAIN.apexX}
                y={MOUNTAIN.baseY - 6}
                textAnchor="middle"
                fontSize={12}
                fill={v('muted')}
              >
                {t('home.hiddenSteps', { before: trail.hiddenBefore, after: trail.hiddenAfter })}
              </text>
            )}
            {me && climber && (
              <Person m={me} x={climber.x} y={climber.y} scale={0.9} onPick={pickCentered} />
            )}
          </>
        )}
      </g>
      <Foothills hills={hills} highlight={nextAssignee} onPick={pick} width={width} />
    </svg>
  );
}

function doneCount(task: Task) {
  return task.steps.filter((s) => s.done).length;
}

function Mountain({ empty }: { empty: boolean }) {
  const { apexX, apexY, baseHalf } = MOUNTAIN;
  const d = `M${apexX - baseHalf - 72} ${SCENE.h}L${apexX - 86} ${apexY + 64}Q${apexX} ${apexY - 66} ${apexX + 86} ${apexY + 64}L${apexX + baseHalf + 48} ${SCENE.h}Z`;
  return (
    <g aria-hidden opacity={empty ? 0.55 : 1}>
      <path d={d} fill={v('mountain')} />
      <path
        d={`M${apexX} ${apexY}Q${apexX + 44} ${apexY + 4} ${apexX + 86} ${apexY + 64}L${apexX + baseHalf + 48} ${SCENE.h}H${apexX + 94}Z`}
        fill={v('surface')}
        opacity={0.3}
      />
      <path
        d={`M${apexX - 50} ${apexY + 46}Q${apexX} ${apexY - 36} ${apexX + 50} ${apexY + 46}q-12 9 -25 0q-12 9 -25 0q-12 9 -25 0q-12 9 -25 0z`}
        fill={v('cloud')}
      />
    </g>
  );
}

function TrailPath({ trail }: { trail: NonNullable<ReturnType<typeof layoutTrail>> }) {
  const pts = [trail.start, ...trail.points, SUMMIT];
  const segs = pts.slice(1).map((p, i) => ({ a: pts[i], b: p }));
  const doneUpTo = trail.points.filter((p) => p.kind === 'done').length;
  return (
    <g aria-hidden fill="none" strokeLinecap="round">
      {segs.map(({ a, b }, i) => {
        const done = i < doneUpTo;
        const now = i === doneUpTo && trail.points[i]?.kind === 'now';
        return (
          <path
            key={i}
            d={`M${a.x} ${a.y}L${b.x} ${b.y}`}
            stroke={done ? v('st-online') : now ? v('primary') : v('laptop-line')}
            strokeWidth={done || now ? 5 : 4}
            strokeDasharray={done || now ? undefined : '2 9'}
          />
        );
      })}
    </g>
  );
}

function CheckpointMark({ p, nameOf }: { p: Checkpoint; nameOf: (id: string | null) => string }) {
  const title =
    p.kind === 'done'
      ? t('home.step.done', { title: p.step.title })
      : p.kind === 'now'
        ? t('home.step.now', { title: p.step.title })
        : p.step.title;
  const sub = p.step.assignee ? nameOf(p.step.assignee) : t('home.unassigned');
  const w = Math.max(textWidth(title, 13), textWidth(sub, 12)) + 24;
  const x0 = p.side === 'right' ? p.x + 24 : p.x - 24 - w;
  const color =
    p.kind === 'done' ? v('st-online-text') : p.kind === 'now' ? v('primary') : v('text');
  return (
    <g>
      {p.kind === 'done' ? (
        <>
          <circle
            cx={p.x}
            cy={p.y}
            r={13}
            fill={v('st-online')}
            stroke={v('surface')}
            strokeWidth={3}
          />
          <path
            d={`M${p.x - 5.5} ${p.y + 0.5}l3.6 3.6 7.4-7.4`}
            stroke={v('surface')}
            strokeWidth={2.4}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : p.kind === 'now' ? (
        <>
          <circle cx={p.x} cy={p.y} r={19} fill={v('primary')} opacity={0.18} />
          <circle
            cx={p.x}
            cy={p.y}
            r={13}
            fill={v('primary')}
            stroke={v('surface')}
            strokeWidth={3}
          />
          <text
            x={p.x}
            y={p.y + 4.5}
            fontSize={12}
            fontWeight={700}
            fill={v('on-primary')}
            textAnchor="middle"
          >
            {p.index + 1}
          </text>
        </>
      ) : (
        <>
          <circle
            cx={p.x}
            cy={p.y}
            r={12}
            fill={v('surface')}
            stroke={v('laptop-line')}
            strokeWidth={2}
          />
          <text
            x={p.x}
            y={p.y + 4.5}
            fontSize={12}
            fontWeight={700}
            fill={v('muted')}
            textAnchor="middle"
          >
            {p.index + 1}
          </text>
        </>
      )}
      <rect
        x={x0}
        y={p.y - 22}
        width={w}
        height={44}
        rx={12}
        fill={v('surface')}
        stroke={v('border')}
      />
      <text x={x0 + 12} y={p.y - 3} fontSize={13} fontWeight={700} fill={color}>
        {title}
      </text>
      <text x={x0 + 12} y={p.y + 13} fontSize={12} fill={v('muted')}>
        {sub}
      </text>
    </g>
  );
}

function SummitFlag({ task, now }: { task: Task; now: number }) {
  const { x, y } = SUMMIT;
  const title = task.dueAt
    ? t('home.summit.due', { time: formatClock(task.dueAt), title: task.title })
    : t('home.summit', { title: task.title });
  const sub = task.dueAt ? t('home.remaining', { time: formatRemaining(task.dueAt - now) }) : '';
  const w = Math.max(textWidth(title, 15), textWidth(sub, 12)) + 32;
  return (
    <g>
      <path
        d={`M${x} ${y - 2}V${y - 60}`}
        stroke={v('text')}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      <path d={`M${x + 1} ${y - 59}l34 10-34 10z`} fill={v('primary')} />
      <rect
        x={x - w / 2}
        y={y - 120}
        width={w}
        height={sub ? 50 : 34}
        rx={14}
        fill={v('primary')}
      />
      <text
        x={x}
        y={y - 99}
        fontSize={15}
        fontWeight={700}
        fill={v('on-primary')}
        textAnchor="middle"
      >
        {title}
      </text>
      {sub && (
        <text x={x} y={y - 81} fontSize={12} fill={v('on-primary')} textAnchor="middle">
          {sub}
        </text>
      )}
    </g>
  );
}

const HILL_FILL = ['hill-near', 'hill-mid', 'hill-far'];

function Foothills({
  hills,
  highlight,
  onPick,
  width,
}: {
  hills: Hill[];
  highlight: string | null;
  onPick: (m: MemberView, x: number, y: number) => void;
  width: number;
}) {
  const n = Math.max(hills.length, 1);
  const span = width / n;
  const peakY = 556;
  return (
    <g>
      {hills.map((h, i) => {
        const cx = span * i + span / 2;
        const half = span * 0.68;
        const d = `M${cx - half} ${SCENE.h}C${cx - half * 0.6} ${peakY + 10} ${cx - half * 0.3} ${peakY - 8} ${cx} ${peakY - 8}S${cx + half * 0.6} ${peakY + 14} ${cx + half} ${SCENE.h}Z`;
        const name =
          h.kind === 'office'
            ? (h.name ?? '')
            : h.kind === 'remote'
              ? t('location.remote')
              : t('location.elsewhere');
        const count = h.members.length + h.more;
        const shown = h.members;
        const gap = Math.min(84, (span - 40) / Math.max(shown.length, 1));
        return (
          <g key={h.id}>
            <path d={d} fill={v(HILL_FILL[i % 3])} />
            {h.kind === 'remote' && <House x={cx + span * 0.32} y={peakY + 10} scale={0.8} />}
            {shown.map((m, j) => {
              const x = cx + (j - (shown.length - 1) / 2) * gap;
              return (
                <Person
                  key={m.id}
                  m={m}
                  x={x}
                  y={peakY + 14 + (j % 2) * 4}
                  scale={0.8}
                  ring={m.id === highlight}
                  compact={gap < 70}
                  onPick={onPick}
                />
              );
            })}
            {h.more > 0 && (
              <NamePill x={cx + span * 0.4} y={peakY - 30} text={`+${h.more}`} size={12} />
            )}
            <g opacity={0.92}>
              <NamePill x={cx} y={SCENE.h - 30} text={`${name} · ${count}`} size={12} />
            </g>
          </g>
        );
      })}
    </g>
  );
}

function Person({
  m,
  x,
  y,
  scale,
  note,
  ring = false,
  compact = false,
  onPick,
}: {
  m: MemberView;
  x: number;
  y: number;
  scale: number;
  note?: string;
  ring?: boolean;
  compact?: boolean;
  onPick: (m: MemberView, x: number, y: number) => void;
}) {
  const name = m.isMe ? t('home.you') : compact ? m.name.slice(-2) : m.name;
  const extra = note ?? (m.offHours ? t('home.offHours') : undefined);
  const text = extra ? `${name} · ${extra}` : name;
  const activate = () => onPick(m, x, y);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={t('home.person', {
        name: m.isMe ? t('home.you') : m.name,
        state: stateLabel(m.presence),
      })}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className="cursor-pointer focus:outline-none [&:focus-visible>g:last-child>rect]:stroke-primary"
    >
      {ring && (
        <circle cx={x} cy={y - 30 * scale} r={40 * scale} fill={v('primary')} opacity={0.16} />
      )}
      <Figure
        x={x}
        y={y}
        state={m.presence ?? 'Offline'}
        look={lookOf(m)}
        scale={scale}
        me={m.isMe}
      />
      <NamePill x={x} y={y + 6} text={text} state={m.presence ?? 'Offline'} ring={ring} />
    </g>
  );
}

// ── 名片（點角色） ──────────────────────────────────────────

function MemberCard({
  picked,
  sceneW,
  sceneH,
  overview,
  now,
  onClose,
  onOpenConv,
}: {
  picked: Picked;
  sceneW: number;
  sceneH: number;
  overview: Overview;
  now: number;
  onClose: () => void;
  onOpenConv: (conv: string) => void;
}) {
  const { member: m } = picked;
  const { busy, error, run } = useAction();
  const knock = defersNotifications(m.presence, m.until, now) || !!m.offHours;
  const office = overview.offices.find((o) => `office:${o.id}` === m.location);
  const place =
    office?.name ?? (m.location === 'remote' ? t('location.remote') : t('location.hidden'));
  const left = `${Math.min(70, Math.max(2, (picked.x / sceneW) * 100 - 14))}%`;
  const top = `${Math.min(64, Math.max(2, ((picked.y - SCENE.h + sceneH) / sceneH) * 100 - 30))}%`;
  return (
    <Popover
      label={m.name}
      onClose={onClose}
      closeOnOutside={false}
      autoFocus={false}
      className="absolute flex w-64 flex-col gap-2 p-4"
      style={{ left, top }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-bold">{m.isMe ? t('home.you') : m.name}</span>
          <StatusBadge state={m.presence} />
        </div>
        <IconButton size="sm" label={t('common.close')} onClick={onClose} autoFocus>
          ×
        </IconButton>
      </div>
      <dl className="grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1 text-sm">
        <dt className="text-muted">{t('card.place')}</dt>
        <dd>{place}</dd>
        {m.until && (
          <>
            <dt className="text-muted">{t('card.back')}</dt>
            <dd>{m.presence === 'Leave' ? formatDate(m.until) : formatClock(m.until)}</dd>
          </>
        )}
        {m.note && (
          <>
            <dt className="text-muted">{t('card.note')}</dt>
            <dd className="break-words">{m.note}</dd>
          </>
        )}
      </dl>
      {!m.isMe && (
        <>
          <Button
            variant="soft"
            disabled={busy}
            onClick={async () => {
              const id = await run(() => api.openDm(m.id));
              if (id) onOpenConv(id);
            }}
          >
            {knock ? t('card.knock') : t('card.message')}
          </Button>
          {knock && <p className="text-xs text-muted">{t('card.knock.hint')}</p>}
        </>
      )}
      <ErrorText message={error} />
    </Popover>
  );
}

// ── 清單檢視（同樣資訊、同樣順序） ────────────────────────────

function SceneList({
  overview,
  task,
  nameOf,
  now,
}: {
  overview: Overview;
  task: Task | null;
  nameOf: (id: string | null) => string;
  now: number;
}) {
  const { hills, leave } = groupByHill(overview.members, overview.offices);
  return (
    <div className="flex flex-col gap-4 bg-surface p-5">
      {task && (
        <div className="flex flex-col gap-2">
          <h3 className="font-bold">
            {task.dueAt
              ? t('home.summit.due', { time: formatClock(task.dueAt), title: task.title })
              : t('home.summit', { title: task.title })}
          </h3>
          <ol className="flex flex-col gap-1 text-sm">
            {task.steps.map((s, i) => (
              <li key={s.id} className="flex gap-2">
                <span aria-hidden>
                  {s.done ? '✓' : i === task.steps.findIndex((x) => !x.done) ? '●' : '○'}
                </span>
                <span className={s.done ? 'text-muted line-through' : ''}>{s.title}</span>
                <span className="text-muted">
                  · {s.assignee ? nameOf(s.assignee) : t('home.unassigned')}
                </span>
              </li>
            ))}
          </ol>
          {task.dueAt && (
            <p className="text-sm text-muted">
              {t('home.remaining', { time: formatRemaining(task.dueAt - now) })}
            </p>
          )}
        </div>
      )}
      {[
        ...hills.map((h) => ({ key: h.id, h })),
        ...(leave.length ? [{ key: 'leave', h: null }] : []),
      ].map(({ key, h }) => {
        const list = h ? h.members : leave;
        const title = h
          ? h.kind === 'office'
            ? h.name
            : h.kind === 'remote'
              ? t('location.remote')
              : t('location.elsewhere')
          : t('location.leave');
        return (
          <div key={key} className="flex flex-col gap-1">
            <h3 className="text-sm font-bold">{title}</h3>
            <ul className="flex flex-col divide-y divide-line text-sm">
              {list.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-1.5">
                  <span className="w-24 truncate font-semibold">
                    {m.isMe ? t('home.you') : m.name}
                  </span>
                  <StatusBadge state={m.presence} />
                  {m.until && (
                    <span className="text-muted">
                      {m.presence === 'Leave'
                        ? t('home.leaveUntil', { date: formatDate(m.until) })
                        : t('home.until', { time: formatClock(m.until) })}
                    </span>
                  )}
                  {m.note && <span className="truncate text-muted">{m.note}</span>}
                </li>
              ))}
              {h && h.more > 0 && <li className="py-1.5 text-muted">+{h.more}</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ── 右側摘要圖卡 ────────────────────────────────────────────

function Ring({ fraction, label, title }: { fraction: number; label: string; title: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width={84}
      height={84}
      viewBox="0 0 84 84"
      role="img"
      aria-label={title}
      className="shrink-0"
    >
      <circle cx={42} cy={42} r={r} fill="none" stroke={v('border')} strokeWidth={9} />
      <circle
        cx={42}
        cy={42}
        r={r}
        fill="none"
        stroke={v('primary')}
        strokeWidth={9}
        strokeLinecap="round"
        strokeDasharray={`${c * fraction} ${c}`}
        transform="rotate(-90 42 42)"
      />
      <text x={42} y={47} fontSize={14} fontWeight={700} fill={v('text')} textAnchor="middle">
        {label}
      </text>
    </svg>
  );
}

function NextStepCard({
  task,
  me,
  nameOf,
  now,
  onOpenTasks,
}: {
  task: Task | null;
  me: MemberView | undefined;
  nameOf: (id: string | null) => string;
  now: number;
  onOpenTasks: () => void;
}) {
  const { busy, error, attempt } = useAction();
  if (!task) {
    return (
      <Card className="flex flex-col gap-3">
        <SectionLabel tone="primary">{t('home.next')}</SectionLabel>
        <EmptyState art="goals">{t('home.empty.desc')}</EmptyState>
        <Button onClick={onOpenTasks}>{t('home.empty.action')}</Button>
      </Card>
    );
  }
  const idx = task.steps.findIndex((s) => !s.done);
  const step = idx === -1 ? null : task.steps[idx];
  const mineToDo = step && (step.assignee === null || step.assignee === me?.id);
  const left = task.dueAt ? formatRemaining(task.dueAt - now) : null;
  return (
    <Card className="flex flex-col gap-3">
      <SectionLabel tone="primary">
        {step ? t('home.next.step', { n: idx + 1, total: task.steps.length }) : t('home.next')}
      </SectionLabel>
      <div className="flex items-center gap-3">
        {left && task.dueAt !== null && (
          <Ring
            fraction={remainingFraction(task, now)}
            label={shortRemaining(task.dueAt - now)}
            title={left}
          />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-lg font-bold break-words">{step ? step.title : task.title}</span>
          <span className="text-sm text-muted">
            {step
              ? step.assignee
                ? nameOf(step.assignee)
                : t('home.unassigned')
              : t('home.noSteps')}
          </span>
        </div>
      </div>
      {step && mineToDo ? (
        <Button
          disabled={busy}
          onClick={() => void attempt(() => api.setStepDone(task.team, task.id, step.id, true))}
        >
          {t('home.markDone')}
        </Button>
      ) : (
        <Button variant="secondary" onClick={onOpenTasks}>
          {t('home.openTask')}
        </Button>
      )}
      <ErrorText message={error} />
    </Card>
  );
}

function UnreadCard({
  convs,
  overview,
  onOpenConv,
}: {
  convs: ConvRow[];
  overview: Overview;
  onOpenConv: (c: string) => void;
}) {
  const me = overview.members.find((m) => m.isMe)?.id;
  const list = convs.filter((c) => c.unread > 0).slice(0, 3);
  const title = (c: ConvRow) =>
    c.kind === 'group'
      ? c.name
      : (overview.members.find((m) => m.id !== me && c.members.includes(m.id))?.name ?? '');
  return (
    <Card className="flex flex-col gap-2">
      <SectionLabel tone="warning">
        {t('home.waiting', { count: convs.filter((c) => c.unread > 0).length })}
      </SectionLabel>
      {list.length === 0 && <EmptyState art="chat">{t('home.waiting.empty')}</EmptyState>}
      {list.map((c) => (
        <div
          key={c.id}
          className="flex items-center justify-between gap-2 border-t border-line pt-2 first-of-type:border-0 first-of-type:pt-0"
        >
          <span className="min-w-0 truncate text-sm">
            <strong>{title(c)}</strong>
            <span className="text-muted"> · {t('chat.unread', { count: c.unread })}</span>
          </span>
          <Button variant="soft" className="shrink-0 px-3 py-1" onClick={() => onOpenConv(c.id)}>
            {t('home.reply')}
          </Button>
        </div>
      ))}
    </Card>
  );
}

function BackSoonCard({
  overview,
  task,
  now,
}: {
  overview: Overview;
  task: Task | null;
  now: number;
}) {
  const horizon = Math.max(task?.dueAt ?? 0, now + 3 * 3600_000);
  const list = useMemo(
    () =>
      backSoon(
        overview.members.filter((m) => !m.isMe && m.presence !== 'Leave'),
        now,
        horizon,
      ),
    [overview.members, now, horizon],
  );
  const W = 248;
  const X = (ms: number) => 10 + ((ms - now) / (horizon - now)) * (W - 20);
  return (
    <Card className="flex flex-col gap-2">
      <SectionLabel tone="success">{t('home.backSoon')}</SectionLabel>
      {list.length === 0 ? (
        <EmptyState art="team">{t('home.backSoon.empty')}</EmptyState>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} 40`} className="w-full" aria-hidden>
            <path
              d={`M10 20H${W - 10}`}
              stroke={v('border')}
              strokeWidth={4}
              strokeLinecap="round"
            />
            <circle cx={10} cy={20} r={6} fill={v('primary')} />
            {list.map((m) => (
              <SceneBadge
                key={m.id}
                x={X(m.until ?? now)}
                y={20}
                state={m.presence ?? 'Offline'}
                r={8}
              />
            ))}
          </svg>
          <ul className="flex flex-col gap-1 text-sm">
            {list.slice(0, 5).map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <StatusBadge state={m.presence} withText={false} />
                <span className="font-semibold">{m.name}</span>
                <span className="text-muted">{stateLabel(m.presence)}</span>
                <span className="ml-auto font-bold">{formatClock(m.until ?? now)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ChooseMountain({
  tasks,
  current,
  manual,
  onClose,
  onOpenTasks,
}: {
  tasks: Task[];
  current: Task | null;
  manual: boolean;
  onClose: () => void;
  onOpenTasks: () => void;
}) {
  const { error, attempt } = useAction();
  const choose = async (team: string | null, id: string | null) => {
    if (await attempt(() => api.setFocus(team, id))) onClose();
  };
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="font-bold">{t('home.choose.title')}</h3>
      {tasks.length === 0 && <EmptyState art="tasks">{t('home.choose.empty')}</EmptyState>}
      <ul className="flex flex-col gap-1">
        {tasks.map((x) => (
          <li key={`${x.team}/${x.id}`}>
            <ListButton
              onClick={() => void choose(x.team, x.id)}
              selected={current?.id === x.id}
              className="justify-between"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{x.title}</span>
                {isPrivateTask(x) && <Badge>{t('tasks.private')}</Badge>}
              </span>
              <span className="shrink-0 text-muted">
                {x.dueAt ? formatClock(x.dueAt) : t('tasks.noDue')}
              </span>
            </ListButton>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {manual && (
          <Button variant="secondary" onClick={() => void choose(null, null)}>
            {t('home.choose.auto')}
          </Button>
        )}
        <Button variant="secondary" onClick={onOpenTasks}>
          {t('home.empty.action')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

// ── 時間格式 ────────────────────────────────────────────────

/** 倒數環中央的短格式：`1:20`、`45′`、`3d`。 */
export function shortRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}′`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}:${String(min % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return t('time.overdue');
  const min = Math.round(ms / 60000);
  if (min < 60) return t('time.minutes', { m: min });
  const h = Math.floor(min / 60);
  if (h < 48) return t('time.hm', { h, m: min % 60 });
  return t('time.days', { d: Math.floor(h / 24) });
}
