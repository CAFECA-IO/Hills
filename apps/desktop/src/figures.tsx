/**
 * 焦點山的插畫元件（ui-spec「視覺語言」，D40）：原創簡筆角色、狀態徽章、名牌、雲、小屋。
 * 只用 tokens.css 的變數上色；狀態同時以顏色、徽章形狀、姿勢與文字表達。
 */
import type { Look, PresenceState } from './api';
import { t, type MessageKey } from './i18n';

const v = (name: string) => `var(--hills-${name})`;

type St = PresenceState | 'Offline';

const BADGE_TOKEN: Record<St, string> = {
  Online: 'st-online',
  Busy: 'st-busy',
  Meeting: 'st-busy',
  Lunch: 'st-lunch',
  Away: 'st-away',
  Focus: 'st-focus',
  Leave: 'st-leave',
  Offline: 'st-offline',
};

export const statusTextClass: Record<St, string> = {
  Online: 'text-st-online-text',
  Busy: 'text-st-busy-text',
  Meeting: 'text-st-busy-text',
  Lunch: 'text-st-lunch-text',
  Away: 'text-st-away-text',
  Focus: 'text-st-focus-text',
  Leave: 'text-st-leave-text',
  Offline: 'text-st-offline-text',
};

export const stateLabel = (s: PresenceState | null) =>
  t(`presence.${s ?? 'Offline'}` as MessageKey);

/** 徽章圖形（以 (0,0) 為中心、半徑 7 繪製）。 */
function BadgeShape({ state }: { state: St }) {
  const common = {
    fill: 'none',
    stroke: v('surface'),
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (state) {
    case 'Online':
      return <path d="M-3 0.2l2 2 4-4" {...common} />;
    case 'Lunch':
      return (
        <>
          <path d="M-3.6 -0.6h7.2a3.6 3.2 0 0 1 -7.2 0z" fill={v('surface')} />
          <path d="M-1 -2.4v-1.4M1.4 -2.4v-1.4" {...common} strokeWidth={1.2} />
        </>
      );
    case 'Away':
      return <path d="M0 -3.6V0l2.2 1.4" {...common} />;
    case 'Focus':
      return <path d="M-3.5 0h7" {...common} strokeWidth={1.9} />;
    case 'Leave':
      return <path d="M-3 0h5.5M0.5 -2.2L2.7 0l-2.2 2.2" {...common} />;
    case 'Offline':
      return <path d="M-2.3 -2.3l4.6 4.6M2.3 -2.3l-4.6 4.6" {...common} stroke={v('st-offline')} />;
    default:
      return null;
  }
}

/** SVG 內的狀態徽章。 */
export function Badge({ x, y, state, r = 7 }: { x: number; y: number; state: St; r?: number }) {
  const off = state === 'Offline';
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle
        r={r}
        fill={off ? v('surface') : v(BADGE_TOKEN[state])}
        stroke={off ? v('st-offline') : v('surface')}
        strokeWidth={off ? 1.6 : 2}
      />
      <g transform={`scale(${r / 7})`}>
        <BadgeShape state={state} />
      </g>
    </g>
  );
}

/** HTML 中的狀態徽章 + 文字。 */
export function StatusBadge({
  state,
  withText = true,
  size = 16,
}: {
  state: PresenceState | null;
  withText?: boolean;
  size?: number;
}) {
  const s: St = state ?? 'Offline';
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={size} height={size} viewBox="-8 -8 16 16" aria-hidden className="shrink-0">
        <Badge x={0} y={0} state={s} r={6.5} />
      </svg>
      {withText ? (
        <span className={`text-sm font-semibold ${statusTextClass[s]}`}>{stateLabel(state)}</span>
      ) : (
        <span className="sr-only">{stateLabel(state)}</span>
      )}
    </span>
  );
}

/** 估計 SVG 文字寬度（CJK 12、拉丁 6.8，以 12px 為準）。 */
export function textWidth(s: string, size = 12): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 255 ? 12 : 6.8;
  return (w * size) / 12;
}

/** 名牌：白底膠囊，左側徽章。(x, y) 為上緣中點。 */
export function NamePill({
  x,
  y,
  text,
  state,
  size = 12,
  bold = true,
  ring = false,
}: {
  x: number;
  y: number;
  text: string;
  state?: St;
  size?: number;
  bold?: boolean;
  ring?: boolean;
}) {
  const k = size / 12;
  const w = textWidth(text, size) + 20 + (state ? 18 : 0);
  const h = 22 * k;
  const x0 = x - w / 2;
  return (
    <g>
      <rect
        x={x0}
        y={y}
        width={w}
        height={h}
        rx={h / 2}
        fill={v('surface')}
        stroke={ring ? v('primary') : v('border')}
        strokeWidth={ring ? 2 : 1}
      />
      {state && <Badge x={x0 + 14} y={y + h / 2} state={state} r={6} />}
      <text
        x={x0 + (state ? 26 : 10)}
        y={y + h / 2 + 4.2 * k}
        fontSize={size}
        fontWeight={bold ? 700 : 500}
        fill={v('text')}
      >
        {text}
      </text>
    </g>
  );
}

/** 原創簡筆角色；腳底在 (x, y)。姿勢依狀態變化。 */
export function Figure({
  x,
  y,
  state,
  look,
  scale = 1,
  me = false,
}: {
  x: number;
  y: number;
  state: St;
  look: Look;
  scale?: number;
  me?: boolean;
}) {
  const sk = v(`skin-${look.skin}`);
  const leg = v('ink-soft');
  const ink = v('ink');
  const walking = state === 'Away';
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={state === 'Offline' ? 0.5 : 1}>
      {me && (
        <ellipse
          rx={22}
          ry={6}
          fill="none"
          stroke={v('primary')}
          strokeWidth={2}
          strokeDasharray="3 3"
        />
      )}
      <ellipse rx={15} ry={4} fill={v('ink')} opacity={0.14} />
      {walking ? (
        <>
          <path d="M-5 -18L-11 -1M5 -18L10 -2" stroke={leg} strokeWidth={5} strokeLinecap="round" />
          <path
            d="M-22 -34h-9M-20 -26h-12M-22 -18h-7"
            stroke={v('border')}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </>
      ) : (
        <path d="M-5 -18V-1M5 -18V-1" stroke={leg} strokeWidth={5} strokeLinecap="round" />
      )}
      <path
        d={
          state === 'Online' || state === 'Busy' || state === 'Lunch'
            ? 'M-10 -37l-3 9M10 -37l3 9'
            : walking
              ? 'M-10 -37l-6 9M10 -37l6 7'
              : state === 'Leave'
                ? 'M-10 -37l-8 -8M10 -37l8 -8'
                : 'M-10 -37l-3 13M10 -37l3 13'
        }
        stroke={sk}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <rect x={-11} y={-43} width={22} height={27} rx={10} fill={v(`shirt-${look.shirt}`)} />
      <circle cy={-53} r={10} fill={sk} />
      <path
        d="M-10.5 -54a10.5 10.5 0 0 1 21 0q-5 -5 -10 -4q-6 1 -11 4z"
        fill={v(`hair-${look.hair}`)}
      />
      {state === 'Leave' ? (
        <path
          d="M-8 -55h6.5v3a2 2 0 0 1 -2 2h-2.5a2 2 0 0 1 -2 -2zM1.5 -55h6.5v3a2 2 0 0 1 -2 2h-2.5a2 2 0 0 1 -2 -2zM-1.5 -54h3"
          fill={ink}
          stroke={ink}
          strokeWidth={0.8}
        />
      ) : (
        <>
          <circle cx={-3.5} cy={-52} r={1.3} fill={ink} />
          <circle cx={3.5} cy={-52} r={1.3} fill={ink} />
          <path
            d={state === 'Busy' ? 'M-2.5 -47q2.5 -2 5 0' : 'M-2.5 -48q2.5 2 5 0'}
            stroke={ink}
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
      {(state === 'Online' || state === 'Busy') && (
        <>
          <rect
            x={-13}
            y={-32}
            width={26}
            height={15}
            rx={2.5}
            fill={v('laptop')}
            stroke={v('laptop-line')}
            strokeWidth={1.5}
          />
          <circle cy={-24.5} r={1.8} fill={v('primary')} />
        </>
      )}
      {state === 'Meeting' && (
        <g stroke={v('st-busy')} strokeWidth={1.6}>
          <rect x={8} y={-86} width={26} height={17} rx={8.5} fill={v('surface')} />
          <path d="M13 -69.5l-3 5 7-5" fill={v('surface')} strokeLinejoin="round" />
          {[15, 21, 27].map((cx) => (
            <circle key={cx} cx={cx} cy={-77.5} r={1.7} fill={v('st-busy')} stroke="none" />
          ))}
        </g>
      )}
      {state === 'Lunch' && (
        <>
          <path
            d="M8 -41l10 -13M11 -40l10 -13"
            stroke={v('st-away-text')}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <path
            d="M-12 -29h24a12 9 0 0 1 -24 0z"
            fill={v('laptop')}
            stroke={v('st-lunch')}
            strokeWidth={1.8}
          />
          <path
            d="M-5 -33q-3 -4 0 -7M1 -33q-3 -4 0 -7"
            stroke={v('st-lunch')}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'Focus' && (
        <>
          <path
            d="M-11.5 -55a11.5 11.5 0 0 1 23 0"
            stroke={v('st-focus')}
            strokeWidth={3}
            fill="none"
          />
          <rect x={-15} y={-58} width={6} height={10} rx={3} fill={v('st-focus')} />
          <rect x={9} y={-58} width={6} height={10} rx={3} fill={v('st-focus')} />
        </>
      )}
      {state === 'Offline' && (
        <>
          <text x={12} y={-66} fontSize={12} fontWeight={700} fill={v('ink-soft')}>
            z
          </text>
          <text x={20} y={-74} fontSize={10} fontWeight={700} fill={v('ink-soft')}>
            z
          </text>
        </>
      )}
    </g>
  );
}

export function Cloud({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill={v('cloud')}>
      <circle cx={-34} r={20} />
      <circle cx={-8} cy={-14} r={28} />
      <circle cx={24} cy={-6} r={22} />
      <circle cx={46} cy={4} r={16} />
      <rect x={-54} width={116} height={20} rx={10} />
    </g>
  );
}

export function House({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} aria-hidden>
      <rect
        x={-14}
        y={-20}
        width={28}
        height={20}
        rx={2}
        fill={v('laptop')}
        stroke={v('laptop-line')}
        strokeWidth={1.5}
      />
      <path d="M-18 -19L0 -34L18 -19z" fill={v('roof')} />
      <rect
        x={-4}
        y={-11}
        width={8}
        height={11}
        fill={v('primary-soft')}
        stroke={v('laptop-line')}
        strokeWidth={1.2}
      />
    </g>
  );
}

export function Sun({ x, y, r = 24 }: { x: number; y: number; r?: number }) {
  return (
    <g aria-hidden>
      <circle cx={x} cy={y} r={r + 16} fill={v('sun-halo')} />
      <circle cx={x} cy={y} r={r} fill={v('sun')} />
    </g>
  );
}

export function SkyGradient({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={v('sky-top')} />
        <stop offset="1" stopColor={v('sky-bottom')} />
      </linearGradient>
    </defs>
  );
}

/** 單獨顯示的角色（設定預覽、名片）。 */
export function Portrait({
  look,
  state,
  size = 72,
  label,
}: {
  look: Look;
  state: PresenceState | null;
  size?: number;
  label: string;
}) {
  return (
    <svg width={size} height={size} viewBox="-40 -96 80 104" role="img" aria-label={label}>
      <Figure x={0} y={0} state={state ?? 'Offline'} look={look} />
    </svg>
  );
}
