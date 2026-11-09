/**
 * 空狀態插畫與載入骨架（design-system §7「載入骨架」、§9「空狀態插畫」v0.6；components.md v0.7）。
 * 只用 token：輪廓 border、強調 primary、底色 bg。
 */
import { useId } from 'react';
import { t } from '../i18n';

export type EmptyArt = 'generic' | 'goals' | 'tasks' | 'chat' | 'knowledge' | 'team' | 'report';

const LINE = 'var(--hills-border)';
const ACCENT = 'var(--hills-primary)';
const FILL = 'var(--hills-bg)';
const SURFACE = 'var(--hills-surface)';

const stroke = {
  fill: 'none',
  stroke: LINE,
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const accent = { ...stroke, stroke: ACCENT } as const;

function Art({ kind }: { kind: EmptyArt }) {
  switch (kind) {
    case 'goals':
      return (
        <>
          <path d="M14 70h22V56h22V42h22V28h26" {...stroke} />
          <path d="M14 70h92" {...stroke} />
          <path d="M96 28V8" {...accent} />
          <path d="M96 8l14 5-14 5" fill={ACCENT} />
        </>
      );
    case 'tasks':
      return (
        <>
          <rect x="30" y="8" width="60" height="66" rx="8" {...stroke} fill={SURFACE} />
          {[24, 40, 56].map((y, i) => (
            <g key={y}>
              <rect
                x="40"
                y={y - 5}
                width="10"
                height="10"
                rx="3"
                {...(i === 0 ? accent : stroke)}
              />
              {i === 0 && <path d={`M42 ${y}l2.5 2.5 4-5`} {...accent} />}
              <path d={`M56 ${y}h24`} {...stroke} />
            </g>
          ))}
        </>
      );
    case 'chat':
      return (
        <>
          <path
            d="M14 14h56a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H34l-12 10V50h-8a8 8 0 0 1-8-8V22a8 8 0 0 1 8-8z"
            {...stroke}
            fill={SURFACE}
          />
          <path
            d="M84 34h20a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8h-4v8l-10-8H84a8 8 0 0 1-8-8"
            {...accent}
          />
          <path d="M24 30h40M24 38h26" {...stroke} />
        </>
      );
    case 'knowledge':
      return (
        <>
          <path d="M28 54L60 24l34 34" {...stroke} strokeDasharray="3 5" />
          {[
            [28, 54, false],
            [60, 24, true],
            [94, 58, false],
          ].map(([x, y, hot]) => (
            <path
              key={`${x}`}
              d={`M${x} ${Number(y) - 9}l2.6 6.4 6.4 2.6-6.4 2.6-2.6 6.4-2.6-6.4-6.4-2.6 6.4-2.6z`}
              fill={hot ? ACCENT : SURFACE}
              stroke={hot ? ACCENT : LINE}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ))}
        </>
      );
    case 'team':
      return (
        <>
          <circle cx="44" cy="30" r="10" {...stroke} fill={SURFACE} />
          <path d="M24 70c2-14 10-20 20-20s18 6 20 20" {...stroke} />
          <circle cx="78" cy="30" r="10" {...accent} fill={SURFACE} />
          <path d="M58 70c2-14 10-20 20-20s18 6 20 20" {...accent} />
        </>
      );
    case 'report':
      return (
        <>
          <path d="M36 6h36l14 14v54H36z" {...stroke} fill={SURFACE} />
          <path d="M72 6v14h14" {...stroke} />
          <path d="M46 34h30M46 44h30M46 54h18" {...stroke} />
          <path d="M46 24h14" {...accent} />
        </>
      );
    default:
      return (
        <>
          <path d="M6 72c18-22 34-30 50-30s30 10 58 30" {...stroke} fill={FILL} />
          <path d="M60 42V10" {...accent} strokeDasharray="4 4" />
          <path
            d="M60 10l14 5-14 5"
            fill="none"
            stroke={ACCENT}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </>
      );
  }
}

/** 空狀態插畫（裝飾性，aria-hidden）。 */
export function EmptyIllustration({ kind = 'generic' }: { kind?: EmptyArt }) {
  return (
    <svg width="120" height="80" viewBox="0 0 120 80" aria-hidden="true" className="shrink-0">
      <Art kind={kind} />
    </svg>
  );
}

export type SkeletonVariant = 'lines' | 'list' | 'cards' | 'board';

const ROW = { lines: 20, list: 52, cards: 96, board: 220 } as const;

/** 載入骨架：一張 SVG，寬度填滿容器，掃光以 CSS 動畫（減少動態時停止）。 */
export function Skeleton({
  variant = 'list',
  count = 3,
  label,
}: {
  variant?: SkeletonVariant;
  count?: number;
  label?: string;
}) {
  const id = useId().replace(/:/g, '');
  const n = Math.max(1, count);
  const W = 600;
  const H = variant === 'cards' || variant === 'board' ? ROW[variant] : n * ROW[variant];
  const block = (x: number, y: number, w: number, h: number, r = 6) => (
    <rect key={`${x}-${y}-${w}`} x={x} y={y} width={w} height={h} rx={r} />
  );
  const shapes: React.ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    if (variant === 'lines') {
      shapes.push(block(0, i * ROW.lines + 4, i === n - 1 ? W * 0.6 : W, 12));
    } else if (variant === 'list') {
      const y = i * ROW.list;
      shapes.push(<circle key={`c${i}`} cx={18} cy={y + 24} r={16} />);
      shapes.push(block(46, y + 10, W * 0.55, 12), block(46, y + 30, W * 0.35, 10));
    } else {
      const gap = 16;
      const w = (W - gap * (n - 1)) / n;
      const x = i * (w + gap);
      if (variant === 'cards') {
        shapes.push(block(x, 0, w, ROW.cards, 12));
      } else {
        shapes.push(block(x, 0, w, 40, 10), block(x, 52, w, 64, 10), block(x, 128, w, 64, 10));
      }
    }
  }
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label ?? t('common.loading')}
      className="w-full overflow-hidden"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={`sk-${id}`}>{shapes}</clipPath>
          <linearGradient id={`sg-${id}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={SURFACE} stopOpacity="0" />
            <stop offset="0.5" stopColor={SURFACE} stopOpacity="0.7" />
            <stop offset="1" stopColor={SURFACE} stopOpacity="0" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#sk-${id})`}>
          <rect width={W} height={H} fill={LINE} opacity={0.6} />
          <rect className="hills-shimmer" width={W} height={H} fill={`url(#sg-${id})`} />
        </g>
      </svg>
    </div>
  );
}
