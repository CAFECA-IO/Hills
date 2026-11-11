/**
 * 小組 › 方向：往山丘走（ui-spec「工作 › 小組」A6，D59；design-system §9「往山丘走」；
 * technical-design §16.14 v0.34）。表格檢視是無障礙替代。
 */
import { useState, type KeyboardEvent } from 'react';
import type { DirectionRules, MemberDirection, MemberView, TeamGoal, TeamView } from './api';
import { Character } from './characters';
import { quarterElapsed } from './drift-utils';
import type { Periods } from './goals-utils';
import {
  SCENE,
  countsOf,
  labelWidth,
  placeLabels,
  pathHalfWidth,
  posOf,
  rankOf,
  walkerOf,
  yOf,
  type HillKind,
  type Walker,
} from './hill-utils';
import { formatDate, t, type MessageKey } from './i18n';
import { lookOf } from './summit';
import { Button, Card, LinkButton, Switch } from './ui';

const MARK: Record<HillKind, string> = {
  onTrack: '●',
  slow: '▼',
  veered: '▲',
  backwards: '↓',
  stopped: '◷',
  unknown: '○',
  leave: '☁',
};

/** 狀態的文字色與外框（形狀 + 文字 + 顏色，不只靠顏色）。 */
const TONE: Record<HillKind, { text: string; pill: string; fill: string }> = {
  onTrack: {
    text: 'text-st-online-text',
    pill: 'border-st-online text-st-online-text',
    fill: 'fill-st-online',
  },
  slow: { text: 'text-primary', pill: 'border-primary text-primary', fill: 'fill-primary' },
  veered: { text: 'text-warning', pill: 'border-warning text-warning', fill: 'fill-warning' },
  backwards: { text: 'text-danger', pill: 'border-danger text-danger', fill: 'fill-danger' },
  stopped: { text: 'text-muted', pill: 'border-line text-muted', fill: 'fill-muted' },
  unknown: { text: 'text-muted', pill: 'border-line text-muted', fill: 'fill-muted' },
  leave: { text: 'text-muted', pill: 'border-line text-muted', fill: 'fill-muted' },
};

export function HillPill({ kind }: { kind: HillKind }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold ${TONE[kind].pill}`}
    >
      <span aria-hidden>{MARK[kind]}</span>
      {t(`hill.kind.${kind}` as MessageKey)}
    </span>
  );
}

export function useWalkers(
  members: MemberView[],
  team: TeamView,
  summaries: MemberDirection[],
  rules: DirectionRules,
  periods: Periods,
  now: number,
): Walker[] {
  const ids = new Set([...team.members, ...team.leads]);
  return members
    .filter((m) => ids.has(m.id))
    .map((m) => walkerOf(m, summaries.find((s) => s.member === m.id)?.weeks, rules, periods, now))
    .sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.member.name.localeCompare(b.member.name));
}

/** 一句話原因（角色卡、表格）。 */
export function reasonOf(w: Walker): string {
  const a = w.a;
  switch (w.kind) {
    case 'stopped':
      return a.idleDays === null
        ? t('hill.why.noActivity')
        : t('hill.why.stopped', { n: a.idleDays });
    case 'backwards':
      return t('hill.why.backwards', { from: Math.round(w.prev ?? 0), to: Math.round(w.progress) });
    case 'veered':
      return a.unaligned
        ? t('hill.why.unaligned')
        : t('hill.why.elsewhere', { share: Math.round(a.share ?? 0) });
    case 'slow':
      return t('hill.why.slow', { p: Math.round(w.progress) });
    case 'onTrack':
      return t('hill.why.onTrack', { p: Math.round(w.progress) });
    case 'leave':
      return w.member.until
        ? t('hill.why.leaveUntil', { date: formatDate(w.member.until) })
        : t('hill.why.leave');
    default:
      return t('hill.why.unknown');
  }
}

export function HillView({
  team,
  goal,
  walkers,
  periods,
  meId,
  onMessage,
  onOpenMember,
}: {
  team: TeamView;
  /** 山頂：本季（或今年）的小組目標 */
  goal: TeamGoal | null;
  walkers: Walker[];
  periods: Periods;
  meId: string;
  onMessage: (member: string) => void;
  onOpenMember?: (member: string) => void;
}) {
  const [trails, setTrails] = useState(true);
  const [table, setTable] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const counts = countsOf(walkers);
  const sel =
    walkers.find((w) => w.member.id === picked) ??
    walkers.find((w) => w.kind !== 'onTrack' && w.kind !== 'leave') ??
    null;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] gap-3 wide:grid-cols-[minmax(0,1fr)_360px] wide:gap-4">
      <Card className="flex min-h-0 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-3 px-1 text-sm">
          <strong className="text-base">{t('hill.title')}</strong>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {goal ? t('hill.summit', { title: goal.title }) : t('hill.noGoal')}
          </span>
          {!table && <Switch label={t('hill.trails')} checked={trails} onChange={setTrails} />}
          <LinkButton className="text-sm" onClick={() => setTable((x) => !x)}>
            {table ? t('hill.asScene') : t('hill.asTable')}
          </LinkButton>
        </div>
        {table ? (
          <HillTable walkers={walkers} />
        ) : (
          <Scene
            team={team}
            walkers={walkers}
            elapsed={quarterElapsed(periods)}
            trails={trails}
            meId={meId}
            onPick={setPicked}
          />
        )}
        {!table && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted">
            <span>{t('hill.legend.forward')}</span>
            <span>{t('hill.legend.line')}</span>
            <span>{t('hill.legend.path')}</span>
            <span>{t('hill.legend.trail')}</span>
          </p>
        )}
      </Card>
      <aside className="scroll-panel flex min-h-0 flex-col gap-3">
        <Card className="flex flex-col gap-2">
          <h2 className="text-sm font-bold">{t('hill.counts')}</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {(['onTrack', 'slow', 'veered', 'backwards', 'stopped'] as const).map((k) => (
              <li key={k} className="flex items-center gap-2">
                <span aria-hidden className={`w-5 font-bold ${TONE[k].text}`}>
                  {MARK[k]}
                </span>
                <span className="min-w-0 flex-1">{t(`hill.count.${k}`)}</span>
                <strong>{counts[k]}</strong>
              </li>
            ))}
          </ul>
        </Card>
        {sel && (
          <Card className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <strong>{sel.member.isMe ? t('hill.you') : sel.member.name}</strong>
              <HillPill kind={sel.kind} />
            </div>
            <p className="text-sm">{reasonOf(sel)}</p>
            <div className="flex flex-wrap gap-2">
              {onOpenMember && (
                <Button size="sm" variant="secondary" onClick={() => onOpenMember(sel.member.id)}>
                  {t('hill.openMember')}
                </Button>
              )}
              {!sel.member.isMe && (
                <Button size="sm" variant="secondary" onClick={() => onMessage(sel.member.id)}>
                  {t('hill.message')}
                </Button>
              )}
            </div>
          </Card>
        )}
        <p className="mt-auto text-xs text-muted">{t('hill.privacy')}</p>
      </aside>
    </div>
  );
}

function Scene({
  team,
  walkers,
  elapsed,
  trails,
  meId,
  onPick,
}: {
  team: TeamView;
  walkers: Walker[];
  elapsed: number;
  trails: boolean;
  meId: string;
  onPick: (id: string) => void;
}) {
  const lineY = yOf(elapsed * 100);
  const walking = walkers.filter((w) => w.kind !== 'leave');
  const resting = walkers.filter((w) => w.kind === 'leave');
  const label = t('hill.aria', {
    team: team.name,
    people: walking
      .map((w) => `${w.member.name}：${t(`hill.kind.${w.kind}` as MessageKey)}`)
      .join('、'),
  });
  const key = (id: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(id);
    }
  };
  const top = SCENE.summit;
  const tagOf = (w: Walker) =>
    `${MARK[w.kind]} ${w.member.id === meId ? t('hill.you') : w.member.name} · ${t(`hill.kind.${w.kind}` as MessageKey)}`;
  const labels = placeLabels(
    walking.map((w) => {
      const p = posOf(w.progress, w.angle, w.side);
      return { id: w.member.id, x: p.x, y: p.y, w: labelWidth(tagOf(w)), side: w.side };
    }),
  );
  return (
    <svg
      viewBox={`0 0 ${SCENE.w} ${SCENE.h}`}
      className="min-h-0 w-full flex-1 rounded-control"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id="hill-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--hills-sky-top)" />
          <stop offset="1" stopColor="var(--hills-sky-bottom)" />
        </linearGradient>
      </defs>
      <rect width={SCENE.w} height={SCENE.h} fill="url(#hill-sky)" />
      <path d="M140,232 Q260,160 370,228 Z" className="fill-hill-far" />
      <path d="M630,228 Q760,150 880,232 Z" className="fill-hill-far" />
      <path d={`M330,${top} Q500,-60 670,${top} Z`} className="fill-mountain" />
      <path d="M458,97 Q500,77 542,97 Q521,90 500,104 Q479,90 458,97 Z" className="fill-surface" />
      <line x1="500" y1="88" x2="500" y2="48" className="stroke-fg" strokeWidth={3} />
      <path d="M500,48 L530,56 L500,64 Z" className="fill-level-year" />
      <rect y={top - 8} width={SCENE.w} height={SCENE.h - top + 8} className="fill-hill-ground" />
      <path
        d={`M${SCENE.cx - pathHalfWidth(SCENE.h)},${SCENE.h} L${SCENE.cx + pathHalfWidth(SCENE.h)},${SCENE.h} L${SCENE.cx + 25},${top} L${SCENE.cx - 25},${top} Z`}
        className="fill-hill-path"
      />
      {[-1, 1].map((s) => (
        <path
          key={s}
          d={`M${SCENE.cx + s * pathHalfWidth(SCENE.h)},${SCENE.h} L${SCENE.cx + s * 25},${top}`}
          className="stroke-hill-path-edge"
          strokeWidth={2}
          strokeDasharray="6 6"
          fill="none"
        />
      ))}
      <line
        x1="230"
        x2="770"
        y1={lineY}
        y2={lineY}
        className="stroke-fg"
        strokeWidth={2}
        strokeDasharray="10 8"
      />
      <rect x="772" y={lineY - 12} width="92" height="24" rx="12" className="fill-fg" />
      <text
        x="818"
        y={lineY + 5}
        fontSize="13"
        fontWeight="700"
        textAnchor="middle"
        className="fill-surface"
      >
        {t('hill.todayLine')}
      </text>
      <text x={SCENE.cx} y={SCENE.h - 6} fontSize="12" textAnchor="middle" className="fill-muted">
        {t('hill.start')}
      </text>

      {resting.map((w, i) => (
        <g key={w.member.id} transform={`translate(${150 + i * 150} 90)`}>
          <ellipse cx={0} cy={-6} rx={64} ry={22} className="fill-surface" opacity={0.9} />
          <g transform="scale(0.55)">
            <Character look={lookOf(w.member)} pose="rest" />
          </g>
          <text y={30} fontSize="12" textAnchor="middle" className="fill-muted">
            {w.member.name} · {reasonOf(w)}
          </text>
        </g>
      ))}

      {walking.map((w) => {
        const p = posOf(w.progress, w.angle, w.side);
        const tone = TONE[w.kind];
        const tag = tagOf(w);
        const labelW = labelWidth(tag);
        const at = labels.get(w.member.id) ?? { x: p.x + 22, y: p.y - 52 };
        const moved = Math.abs(at.y - (p.y - 52)) > 1;
        return (
          <g key={w.member.id}>
            {trails &&
              w.trail.map((s, i) => {
                const q = posOf(s.progress, s.angle, w.side);
                return (
                  <circle
                    key={i}
                    cx={q.x}
                    cy={q.y}
                    r={3.2}
                    className="fill-trail"
                    opacity={0.3 + (0.5 * (i + 1)) / Math.max(1, w.trail.length)}
                  />
                );
              })}
            <g
              role="button"
              tabIndex={0}
              aria-label={`${tag}。${reasonOf(w)}`}
              className="cursor-pointer outline-none focus-visible:opacity-80"
              transform={`translate(${p.x} ${p.y}) scale(${p.scale * 1.4})`}
              onClick={() => onPick(w.member.id)}
              onKeyDown={key(w.member.id)}
            >
              <g opacity={w.kind === 'stopped' ? 0.55 : 1}>
                <Character look={lookOf(w.member)} pose={w.kind === 'stopped' ? 'rest' : 'walk'} />
              </g>
              {w.kind === 'stopped' && (
                <text x={10} y={-66} fontSize="12" fontWeight="700" className="fill-muted">
                  z z
                </text>
              )}
              {w.kind === 'onTrack' && <path d="M0,-80 L-6,-71 L6,-71 Z" className={tone.fill} />}
              {w.kind === 'backwards' && <path d="M0,14 L-6,6 L6,6 Z" className={tone.fill} />}
            </g>
            {moved && (
              <line
                x1={p.x}
                y1={p.y - 40}
                x2={at.x < p.x ? at.x + labelW : at.x}
                y2={at.y + 12}
                className={`stroke-current ${tone.text}`}
                strokeWidth={1}
                opacity={0.6}
              />
            )}
            <g transform={`translate(${at.x} ${at.y})`}>
              <rect
                width={labelW}
                height={24}
                rx={12}
                className={`fill-surface stroke-current ${tone.text}`}
              />
              <text
                x={labelW / 2}
                y={16}
                fontSize="12"
                fontWeight="700"
                textAnchor="middle"
                className={`fill-current ${tone.text}`}
              >
                {tag}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/** 表格檢視：四項檢查的依據與四週長條（無障礙替代）。 */
function HillTable({ walkers }: { walkers: Walker[] }) {
  const mark = (on: boolean) => (on ? '▲' : '✓');
  return (
    <div className="scroll-panel min-h-0 flex-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="py-2 pr-2 font-semibold">{t('hill.col.member')}</th>
            <th className="py-2 pr-2 font-semibold">{t('hill.col.aligned')}</th>
            <th className="py-2 pr-2 font-semibold">{t('hill.col.share')}</th>
            <th className="py-2 pr-2 font-semibold">{t('hill.col.progress')}</th>
            <th className="py-2 pr-2 font-semibold">{t('hill.col.fresh')}</th>
            <th className="py-2 pr-2 font-semibold">{t('hill.col.weeks')}</th>
            <th className="py-2 font-semibold">{t('hill.col.result')}</th>
          </tr>
        </thead>
        <tbody>
          {walkers.map((w) => (
            <tr key={w.member.id} className="border-b border-line">
              <td className="py-2 pr-2 font-semibold">
                {w.member.isMe ? t('hill.you') : w.member.name}
              </td>
              <td className="py-2 pr-2">{mark(w.a.unaligned)}</td>
              <td className="py-2 pr-2">
                {mark(w.a.elsewhere)} {w.a.share === null ? '—' : `${Math.round(w.a.share)}%`}
              </td>
              <td className="py-2 pr-2">
                {mark(w.a.behind || w.kind === 'backwards')} {Math.round(w.progress)}%
                {w.prev !== null && ` (${Math.round(w.prev)}%)`}
              </td>
              <td className="py-2 pr-2">
                {mark(w.a.stale)}{' '}
                {w.a.idleDays === null
                  ? '—'
                  : w.a.idleDays === 0
                    ? t('hill.today')
                    : t('hill.daysAgo', { n: w.a.idleDays })}
              </td>
              <td className="py-2 pr-2">
                <span className="flex items-end gap-0.5" aria-label={t('hill.col.weeks')}>
                  {[
                    ...w.trail.map((x) => 90 - x.angle),
                    w.a.share === null ? null : 90 - w.angle,
                  ].map((v, i) => (
                    <span
                      key={i}
                      className={`w-2 rounded-sm ${v === null ? 'bg-line' : 'bg-primary'}`}
                      style={{ height: `${4 + ((v ?? 0) / 90) * 16}px` }}
                    />
                  ))}
                </span>
              </td>
              <td className="py-2">
                <span className="flex flex-col gap-0.5">
                  <HillPill kind={w.kind} />
                  <span className="text-xs text-muted">{reasonOf(w)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
