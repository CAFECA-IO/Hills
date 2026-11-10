/**
 * 焦點山的插畫元件（ui-spec「視覺語言」，D40）：原創簡筆角色、狀態徽章、名牌、雲、小屋。
 * 只用 tokens.css 的變數上色；狀態同時以顏色、徽章形狀、姿勢與文字表達。
 */
import { useId } from 'react';
import type { Look, MemberView, PresenceState } from './api';
import { t, type MessageKey } from './i18n';
import {
  Character,
  CharacterArt,
  CharacterHead,
  type Pose,
  SCENE_HEAD_Y,
  SCENE_SCALE,
} from './characters';
import { AVATAR_TONES, idHash, lookOf, moonLitPath, moonPhase } from './summit';

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
export function SceneBadge({
  x,
  y,
  state,
  r = 7,
}: {
  x: number;
  y: number;
  state: St;
  r?: number;
}) {
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
        <SceneBadge x={0} y={0} state={s} r={6.5} />
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
      {state && <SceneBadge x={x0 + 14} y={y + h / 2} state={state} r={6} />}
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
  const ink = v('ink');
  const hy = SCENE_HEAD_Y;
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
      {state === 'Away' && (
        <path
          d="M-14 -40h-9M-12 -32h-12M-14 -24h-7"
          stroke={v('border')}
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
      <Character look={look} pose={POSE[state]} />
      {state === 'Leave' && (
        <path
          d={`M-2.6 ${hy - 0.9}h2.1v1.2a.6 .6 0 0 1 -.6 .6h-.9a.6 .6 0 0 1 -.6 -.6zM.5 ${hy - 0.9}h2.1v1.2a.6 .6 0 0 1 -.6 .6h-.9a.6 .6 0 0 1 -.6 -.6zM-.5 ${hy - 0.6}h1`}
          fill={ink}
          stroke={ink}
          strokeWidth={0.4}
        />
      )}
      {state === 'Meeting' && (
        <g stroke={v('st-busy')} strokeWidth={1.6}>
          <rect x={5} y={-84} width={26} height={17} rx={8.5} fill={v('surface')} />
          <path d="M10 -67.5l-3 5 7-5" fill={v('surface')} strokeLinejoin="round" />
          {[12, 18, 24].map((cx) => (
            <circle key={cx} cx={cx} cy={-75.5} r={1.7} fill={v('st-busy')} stroke="none" />
          ))}
        </g>
      )}
      {state === 'Lunch' && (
        <>
          <path
            d={`M2 ${HAND_Y - 2}l6 -8M4 ${HAND_Y - 1.4}l6 -8`}
            stroke={v('st-away-text')}
            strokeWidth={1}
            strokeLinecap="round"
          />
          <path
            d={`M-5 ${HAND_Y - 1}h10a5 4 0 0 1 -10 0z`}
            fill={v('laptop')}
            stroke={v('st-lunch')}
            strokeWidth={1.2}
          />
          <path
            d={`M-2 ${HAND_Y - 3}q-2 -2.5 0 -4.5M1 ${HAND_Y - 3}q-2 -2.5 0 -4.5`}
            stroke={v('st-lunch')}
            strokeWidth={1}
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
      {state === 'Focus' && (
        <>
          <path
            d={`M-4.4 ${hy}a4.4 4.4 0 0 1 8.8 0`}
            stroke={v('st-focus')}
            strokeWidth={1.4}
            fill="none"
          />
          <rect x={-5.4} y={hy - 1} width={2} height={3.4} rx={1} fill={v('st-focus')} />
          <rect x={3.4} y={hy - 1} width={2} height={3.4} rx={1} fill={v('st-focus')} />
        </>
      )}
      {state === 'Offline' && (
        <>
          <text x={6} y={-64} fontSize={10} fontWeight={700} fill={v('ink-soft')}>
            z
          </text>
          <text x={12} y={-71} fontSize={8} fontWeight={700} fill={v('ink-soft')}>
            z
          </text>
        </>
      )}
    </g>
  );
}

/** 各狀態的姿勢（ui-spec 狀態表）：上線 / 忙碌 / 專注捧筆電，午休端碗，休假舉手，暫離走路。 */
const POSE: Record<St, Pose> = {
  Online: 'laptop',
  Busy: 'laptop',
  Focus: 'laptop',
  Meeting: 'rest',
  Lunch: 'hold',
  Away: 'walk',
  Leave: 'wave',
  Offline: 'rest',
};
/** 場景座標中雙手的高度（端碗位置）。 */
const HAND_Y = (105 - 226) * SCENE_SCALE;

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

/** 依日期計算月相的月亮（ui-spec「視覺語言」日夜）。 */
export function Moon({ x, y, r = 22, now }: { x: number; y: number; r?: number; now: number }) {
  const lit = moonLitPath(moonPhase(now), x, y, r);
  return (
    <g aria-hidden>
      <circle cx={x} cy={y} r={r + 14} fill={v('moon-halo')} />
      <circle cx={x} cy={y} r={r} fill={v('moon-shadow')} />
      {lit && <path d={lit} fill={v('moon')} />}
      {[
        [-150, -26, 1.6],
        [-96, 34, 1.2],
        [-210, 18, 1.4],
        [40, 46, 1.1],
      ].map(([dx, dy, rr]) => (
        <circle key={`${dx}${dy}`} cx={x + dx} cy={y + dy} r={rr} fill={v('moon')} />
      ))}
    </g>
  );
}

/** 淺色模式顯示太陽、深色模式顯示月亮（跟隨系統外觀）。 */
export function SkyLight({ x, y, now }: { x: number; y: number; now: number }) {
  return (
    <>
      <g className="dark:hidden">
        <Sun x={x} y={y} />
      </g>
      <g className="hidden dark:inline">
        <Moon x={x} y={y} now={now} />
      </g>
    </>
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
    <svg width={size} height={size} viewBox="-30 -84 60 90" role="img" aria-label={label}>
      <Figure x={0} y={0} state={state ?? 'Offline'} look={look} />
    </svg>
  );
}

/**
 * 頭肩像（方向羅盤的人像，design-system §9「方向羅盤」）：圓形底、外框顏色表示狀態，
 * 右上角徽章 ✓ / ▲ / 時鐘。`ring` 為 token 名稱（例如 `primary`、`warning`）。
 */
export function Bust({
  look,
  size,
  ring,
  badge,
  faded = false,
}: {
  look: Look;
  size: number;
  ring: string;
  badge?: 'ok' | 'warn' | 'stale';
  faded?: boolean;
}) {
  const clip = useId();
  return (
    <svg
      width={size}
      height={size + 6}
      viewBox="-22 -22 44 50"
      aria-hidden="true"
      opacity={faded ? 0.6 : 1}
    >
      <defs>
        <clipPath id={clip}>
          <circle r={18} />
        </clipPath>
      </defs>
      <path d="M-5 21L0 28L5 21z" fill={v(ring)} />
      <circle r={20.5} fill={v(ring)} />
      <circle r={18} fill={v('bg')} />
      <g clipPath={`url(#${clip})`}>
        <CharacterHead look={look} />
      </g>
      {badge === 'warn' && (
        <>
          <path
            d="M15 -21L23 -7H7z"
            fill={v('warning')}
            stroke={v('surface')}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <path d="M15 -16v4" stroke={v('surface')} strokeWidth={1.6} strokeLinecap="round" />
        </>
      )}
      {badge === 'stale' && (
        <>
          <circle
            cx={15}
            cy={-14}
            r={7}
            fill={v('muted')}
            stroke={v('surface')}
            strokeWidth={1.5}
          />
          <path
            d="M15 -18v4l2.5 1.5"
            stroke={v('surface')}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
      {badge === 'ok' && (
        <>
          <circle
            cx={15}
            cy={-14}
            r={6.5}
            fill={v('st-online')}
            stroke={v('surface')}
            strokeWidth={1.5}
          />
          <path
            d="M12.2 -14l2 2l3.6 -3.8"
            stroke={v('surface')}
            strokeWidth={1.5}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

// ── 圓形頭像（design-system §9 v0.8、components「Avatar」，D58） ─────────────

type AvatarMember = Pick<MemberView, 'id' | 'look' | 'presence'>;

/**
 * 角色的圓形頭肩像。取景與 `characters.tsx` 的繪製座標一致（頭部中心約在 (50, 33)）。
 * 名字與狀態由畫面以文字提供，這裡 `aria-hidden`。
 */
export function Avatar({
  member,
  size,
  me = false,
  badge = true,
}: {
  member: AvatarMember;
  size: number;
  me?: boolean;
  badge?: boolean;
}) {
  const clip = useId();
  const st: St = member.presence ?? 'Offline';
  const r = me ? 27.4 : 30;
  return (
    <svg
      width={size}
      height={size}
      viewBox="20 11 60 60"
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <defs>
        <clipPath id={clip}>
          <circle cx={50} cy={41} r={r} />
        </clipPath>
      </defs>
      <g opacity={st === 'Offline' ? 0.55 : 1}>
        <circle cx={50} cy={41} r={r} fill={v(`avatar-${idHash(member.id) % AVATAR_TONES}`)} />
        <g clipPath={`url(#${clip})`}>
          <CharacterArt look={lookOf(member)} pose="rest" />
        </g>
      </g>
      {me && <circle cx={50} cy={41} r={29} fill="none" stroke={v('primary')} strokeWidth={2.6} />}
      {badge && size > 24 && (
        <g transform="translate(70 61) scale(1.15)">
          <circle r={8.4} fill={v('surface')} />
          <circle r={7} fill={v(BADGE_TOKEN[st])} />
          <BadgeShape state={st} />
        </g>
      )}
    </svg>
  );
}

/** 群組的交疊頭像：第一位在左上、第二位在右下。 */
export function AvatarPair({
  members,
  size,
  ringClass = 'ring-surface',
}: {
  members: AvatarMember[];
  size: number;
  /** 交疊處的白邊顏色（選取列用 `ring-primary-soft`） */
  ringClass?: string;
}) {
  const [a, b] = members;
  const small = Math.round(size * 0.68);
  return (
    <span aria-hidden="true" className="relative shrink-0" style={{ width: size, height: size }}>
      {a && (
        <span className={`absolute top-0 left-0 flex rounded-full ring-2 ${ringClass}`}>
          <Avatar member={a} size={small} badge={false} />
        </span>
      )}
      {b && (
        <span className={`absolute right-0 bottom-0 flex rounded-full ring-2 ${ringClass}`}>
          <Avatar member={b} size={small} badge={false} />
        </span>
      )}
    </span>
  );
}
