/**
 * 方向羅盤（design-system §9「方向羅盤」，ui-spec「目標 → 團隊」D7，D47）：
 * 傾斜地面上，紫色箭頭是小組方向，每人一條箭頭（角度 = 時間花在哪裡、長度 = 季目標進度），
 * 尖端是角色頭肩像；滑過或聚焦人像顯示摘要。
 */
import type { ReactNode } from 'react';
import type { Look } from './api';
import { flat, layoutPins, toScreen, type DriftState, type Plane } from './drift-utils';
import { Bust } from './figures';
import { t } from './i18n';
import { Pressable, Tooltip } from './ui';

export interface CompassPerson {
  id: string;
  name: string;
  look: Look;
  /** 0–90° */
  angle: number;
  /** 季目標進度 0–100（null 視為 0） */
  progress: number | null;
  state: DriftState;
  /** 目標沒對齊團隊（畫虛線） */
  unaligned: boolean;
  isMe: boolean;
  side: number;
  tip?: ReactNode;
  /** 前幾週的位置（舊 → 新，不含現在；第 4 批「四週軌跡」） */
  trail?: { angle: number; progress: number }[];
  /** 半透明的預覽人像（週一方向時刻的「調整後」） */
  ghost?: boolean;
  /** 人像名牌的文字（預設為姓名或「你」） */
  tag?: string;
}

type Mode = 'full' | 'me' | 'mini';

const SIZES: Record<
  Mode,
  { rot: number; squash: number; avatar: number; stem: number; pad: number }
> = {
  full: { rot: -5, squash: 0.78, avatar: 36, stem: 18, pad: 34 },
  me: { rot: -7, squash: 0.58, avatar: 40, stem: 10, pad: 16 },
  mini: { rot: -7, squash: 0.58, avatar: 0, stem: 0, pad: 6 },
};

/** 線條與人像外框的 token（design-system §2.2）。 */
function colorOf(p: CompassPerson): { stroke: string; ring: string } {
  if (p.state === 'stale') return { stroke: 'stroke-muted', ring: 'border' };
  if (p.state === 'warn') return { stroke: 'stroke-warning', ring: 'warning' };
  if (p.isMe) return { stroke: 'stroke-fg', ring: 'text' };
  return { stroke: 'stroke-primary', ring: 'surface' };
}

export function DirectionCompass({
  people,
  mode,
  width,
  height,
  radius,
  today,
  teamLabel,
  cone = 45,
  onOpen,
  pinned,
  label,
  mean,
}: {
  people: CompassPerson[];
  mode: Mode;
  width: number;
  height: number;
  radius: number;
  /** 今天應到的進度（0–100） */
  today: number;
  teamLabel?: string;
  cone?: number;
  onOpen?: (id: string) => void;
  /** 固定顯示摘要的人（設計稿、測試） */
  pinned?: string;
  label: string;
  /** 大家實際走向（度，正 = 偏右）；null / undefined 不畫 */
  mean?: number | null;
}) {
  const size = SIZES[mode];
  const plane: Plane = {
    cx: width / 2,
    cy: height - (mode === 'mini' ? 6 : mode === 'me' ? 18 : 28),
    rot: size.rot,
    squash: size.squash,
  };
  const R = radius;
  const Rf = R + size.pad;
  const ns = { vectorEffect: 'non-scaling-stroke' as const };
  const shown = mode === 'me' ? people.filter((p) => p.isMe || p.ghost) : people;
  const radiusOf = (progress: number | null) => Math.max((R * (progress ?? 0)) / 100, R * 0.09);
  const geo = shown.map((p) => {
    const r = radiusOf(p.progress);
    const [fx, fy] = flat(p.angle, r, p.side);
    const [x, y] = toScreen(plane, fx, fy);
    return { p, fx, fy, x, y };
  });
  const pins = layoutPins(
    geo.map((g) => ({ key: g.p.id, x: g.x, y: g.y })),
    size.stem,
    size.avatar + 14,
    size.avatar + 26,
  );
  const [x1, y1] = flat(cone, Rf, -1);
  const rt = (R * today) / 100;
  const team = R + (mode === 'mini' ? 6 : 20);
  const [tx, ty] = toScreen(plane, 0, -team);
  const [e1x, e1y] = toScreen(plane, -Rf, 0);
  const [e2x, e2y] = toScreen(plane, Rf, 0);
  const edge = mode === 'mini' ? 3 : 8;
  const flag = mode === 'full' ? 1 : 0.62;
  return (
    <div className="relative" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
      >
        <g
          transform={`translate(${plane.cx} ${plane.cy}) scale(1 ${plane.squash}) rotate(${plane.rot})`}
        >
          <path
            d={`M${-Rf} 0A${Rf} ${Rf} 0 0 1 ${Rf} 0Z`}
            className="fill-drift-floor stroke-line"
            strokeWidth={1}
            style={ns}
          />
          <path
            d={`M0 0L${x1.toFixed(1)} ${y1.toFixed(1)}A${Rf} ${Rf} 0 0 1 ${(-x1).toFixed(1)} ${y1.toFixed(1)}Z`}
            className="fill-drift-zone"
          />
          {mode !== 'mini' &&
            [25, 50, 75, 100].map((pct) => {
              const r = (R * pct) / 100;
              return (
                <path
                  key={pct}
                  d={`M${-r} 0A${r} ${r} 0 0 1 ${r} 0`}
                  fill="none"
                  className="stroke-line"
                  strokeWidth={1}
                  style={ns}
                />
              );
            })}
          <path
            d={`M${-rt} 0A${rt} ${rt} 0 0 1 ${rt} 0`}
            fill="none"
            className="stroke-fg"
            strokeOpacity={0.5}
            strokeWidth={mode === 'mini' ? 1.2 : 1.8}
            strokeDasharray={mode === 'mini' ? '2 2' : '6 5'}
            style={ns}
          />
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={-team}
            className="stroke-level-year"
            strokeWidth={mode === 'mini' ? 2 : 6}
            strokeLinecap="round"
            style={ns}
          />
          {geo.map(({ p, fx, fy }) => (
            <line
              key={p.id}
              x1={0}
              y1={0}
              x2={fx}
              y2={fy}
              className={colorOf(p).stroke}
              strokeWidth={mode === 'mini' ? (p.isMe ? 2.6 : 1.5) : p.isMe ? 5 : 3}
              strokeLinecap="round"
              strokeDasharray={p.state === 'stale' ? '2 6' : p.unaligned ? '10 7' : undefined}
              strokeOpacity={p.ghost ? 0.4 : 1}
              style={ns}
            />
          ))}
          {mode !== 'mini' &&
            geo.map(({ p, fx, fy }) =>
              p.trail && p.trail.length > 0 ? (
                <path
                  key={`trail-${p.id}`}
                  d={`M${[
                    ...p.trail.map((q) => flat(q.angle, radiusOf(q.progress), p.side)),
                    [fx, fy],
                  ]
                    .map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`)
                    .join('L')}`}
                  fill="none"
                  className={colorOf(p).stroke}
                  strokeWidth={1.6}
                  strokeDasharray="1 5"
                  strokeLinecap="round"
                  style={ns}
                />
              ) : null,
            )}
          {mode === 'full' && mean !== null && mean !== undefined && (
            <line
              x1={0}
              y1={0}
              x2={flat(Math.abs(mean), R, mean >= 0 ? 1 : -1)[0]}
              y2={flat(Math.abs(mean), R, mean >= 0 ? 1 : -1)[1]}
              className="stroke-level-year"
              strokeOpacity={0.6}
              strokeWidth={2.5}
              strokeDasharray="3 5"
              strokeLinecap="round"
              style={ns}
            />
          )}
        </g>
        <path
          d={`M${e1x} ${e1y}L${e2x} ${e2y}L${e2x} ${e2y + edge}L${e1x} ${e1y + edge}Z`}
          className="fill-drift-floor-edge"
        />
        <circle cx={plane.cx} cy={plane.cy} r={mode === 'mini' ? 3 : 6} className="fill-fg" />
        {mode === 'mini' ? (
          <circle cx={tx} cy={ty} r={3} className="fill-level-year" />
        ) : (
          <g transform={`translate(${tx} ${ty}) scale(${flag})`}>
            <path
              d="M-46 4L-14 -34L0 -18L14 -40L46 4Z"
              className="fill-level-year"
              opacity={0.25}
            />
            <path
              d="M14 -40V-74"
              className="stroke-level-year"
              strokeWidth={3}
              strokeLinecap="round"
            />
            <path d="M14 -74L40 -66L14 -58Z" className="fill-level-year" />
          </g>
        )}
        {mode !== 'mini' && teamLabel && (
          <text
            x={tx + (mode === 'full' ? 44 : 28)}
            y={ty - (mode === 'full' ? 60 : 38)}
            className="fill-level-year text-xs font-bold"
          >
            {teamLabel}
          </text>
        )}
        {mode === 'full' && (
          <>
            <text
              x={toScreen(plane, -rt, 0)[0] - 8}
              y={toScreen(plane, -rt, 0)[1] + 4}
              textAnchor="end"
              className="fill-muted text-2xs"
            >
              {t('drift.compass.today', { pct: Math.round(today) })}
            </text>
            <text
              x={toScreen(plane, -R, 0)[0] - 8}
              y={toScreen(plane, -R, 0)[1] + 4}
              textAnchor="end"
              className="fill-muted text-2xs"
            >
              {t('drift.compass.end')}
            </text>
            <text
              x={toScreen(plane, ...flat(cone, Rf, 1))[0] + 6}
              y={toScreen(plane, ...flat(cone, Rf, 1))[1]}
              className="fill-st-online-text text-2xs font-bold"
            >
              {t('drift.compass.zone')}
            </text>
          </>
        )}
        {mode !== 'mini' &&
          geo.flatMap(({ p }) =>
            (p.trail ?? []).map((q, i, arr) => {
              const [x, y] = toScreen(plane, ...flat(q.angle, radiusOf(q.progress), p.side));
              return (
                <circle
                  key={`dot-${p.id}-${i}`}
                  cx={x}
                  cy={y}
                  r={2.5 + i}
                  className={colorOf(p).stroke.replace('stroke-', 'fill-')}
                  opacity={0.25 + (0.5 * (i + 1)) / (arr.length + 1)}
                />
              );
            }),
          )}
        {mode === 'full' && mean !== null && mean !== undefined && (
          // 標在羅盤外緣（人像多半在內側），朝外對齊並加底色描邊以免被線條蓋住
          <text
            x={toScreen(plane, ...flat(Math.abs(mean), R * 1.03, mean >= 0 ? 1 : -1))[0]}
            y={toScreen(plane, ...flat(Math.abs(mean), R * 1.03, mean >= 0 ? 1 : -1))[1] - 4}
            textAnchor={mean >= 0 ? 'start' : 'end'}
            paintOrder="stroke"
            strokeWidth={4}
            strokeLinejoin="round"
            className="fill-level-year stroke-surface text-2xs font-bold"
          >
            {t(mean >= 0 ? 'drift.mean.right' : 'drift.mean.left', {
              deg: Math.round(Math.abs(mean)),
            })}
          </text>
        )}
        {mode === 'mini'
          ? geo.map(({ p, x, y }) => (
              <circle
                key={p.id}
                cx={x}
                cy={y}
                r={p.isMe ? 3 : 2.2}
                className={colorOf(p).stroke.replace('stroke-', 'fill-')}
              />
            ))
          : pins.map((pin) => (
              <g key={pin.key}>
                <ellipse cx={pin.x} cy={pin.y} rx={9} ry={3} className="fill-fg" opacity={0.18} />
                <line
                  x1={pin.x}
                  y1={pin.y}
                  x2={pin.ax}
                  y2={pin.ay}
                  className="stroke-fg"
                  strokeOpacity={0.35}
                  strokeWidth={1.5}
                />
              </g>
            ))}
        {mode === 'full' &&
          geo.map(({ p, fx, fy }) =>
            p.angle > cone ? (
              <text
                key={p.id}
                x={toScreen(plane, fx, fy)[0] + 14}
                y={toScreen(plane, fx, fy)[1] + 18}
                className="fill-warning text-2xs font-bold"
              >
                {t('drift.compass.off', { deg: Math.round(p.angle) })}
              </text>
            ) : null,
          )}
      </svg>
      {mode !== 'mini' &&
        pins.map((pin) => {
          const g = geo.find((x) => x.p.id === pin.key);
          if (!g) return null;
          const p = g.p;
          const c = colorOf(p);
          const avatar = size.avatar + (p.isMe ? 8 : 0);
          const badge = p.ghost
            ? undefined
            : p.state === 'warn'
              ? 'warn'
              : p.state === 'stale'
                ? 'stale'
                : p.isMe
                  ? 'ok'
                  : undefined;
          const body = (
            <Pressable
              aria-label={t('drift.compass.person', { name: p.isMe ? t('drift.you') : p.name })}
              className="group flex flex-col items-center rounded-full"
              onClick={() => onOpen?.(p.id)}
            >
              <span
                className={`transition-transform duration-(--hills-motion) group-hover:-translate-y-0.5 group-hover:scale-108 group-focus-visible:scale-108 motion-reduce:transition-none ${p.ghost ? 'opacity-45' : ''}`}
              >
                <Bust
                  look={p.look}
                  size={avatar}
                  ring={c.ring}
                  badge={badge}
                  faded={p.state === 'stale'}
                />
              </span>
              <span
                className={`-mt-0.5 rounded-full px-1.5 text-2xs font-bold whitespace-nowrap shadow-sm ${p.isMe ? 'bg-fg text-surface' : 'bg-surface text-fg'}`}
              >
                {p.tag ?? (p.isMe ? t('drift.you') : p.name)}
              </span>
            </Pressable>
          );
          return (
            <div
              key={pin.key}
              className="absolute -translate-x-1/2 -translate-y-full hover:z-20 focus-within:z-20"
              style={{ left: pin.ax, top: pin.ay + 18 }}
            >
              {p.tip && mode === 'full' ? (
                <Tooltip
                  content={p.tip}
                  side={pin.ax > width * 0.55 ? 'left' : 'right'}
                  open={pinned === p.id}
                >
                  {body}
                </Tooltip>
              ) : (
                body
              )}
            </div>
          );
        })}
    </div>
  );
}
