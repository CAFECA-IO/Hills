/**
 * 角色（D69；design-system §9 v0.12、components「Character、CharacterStage」v0.15）：
 * 人類角色，由髮型（含臉與體型）、服裝款式與三種顏色組成；咖啡色描邊、約 3.8 頭身。
 *
 * 造型的路徑在 character-parts.tsx（160 × 284，雙腳在 y = 246）。對外仍用原本的繪製座標：
 * 寬 100、高 240，雙腳在 (50, 224)；`Character` 把原點換到兩腳中間、總高約 64 單位，供場景使用。
 * 只用 token 上色。
 */
import type { Look } from './api';
import {
  BODY,
  FOOT_L,
  FOOT_R,
  HEAD_BODY,
  OUTFIT_BODY,
  OUTFIT_FEET,
  OUTFIT_LEGS,
  headBack,
  headFront,
  outfitOverlay,
  type BodyShape,
  type BodyType,
  type Paint,
} from './character-parts';

const v = (name: string) => `var(--hills-${name})`;

/** 髮型與服裝款式的數量（team.rs LOOK_HEADS、LOOK_OUTFITS）。 */
export const HEAD_COUNT = 8;
export const OUTFIT_COUNT = 8;

/** 姿勢：捧筆電、雙手在前（拿碗等）、手放下、舉手（休假）、走路（暫離）。 */
export type Pose = 'laptop' | 'hold' | 'rest' | 'wave' | 'walk';

const wrap = (n: number | null | undefined, size: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? ((Math.trunc(n) % size) + size) % size : fallback;

/** 髮型：沒有 `head` 的舊資料依舊角色對應（男性 0、女性 4；technical-design §16.8）。 */
export const headOf = (look: Look): number => wrap(look.head, HEAD_COUNT, look.kind === 1 ? 4 : 0);
export const outfitOf = (look: Look): number => wrap(look.outfit, OUTFIT_COUNT, headOf(look));

export function paintOf(look: Look): Paint {
  const hair = wrap(look.hair, 6, 0);
  const skin = wrap(look.skin, 6, 0);
  const shirt = wrap(look.shirt, 6, 0);
  return {
    hair: v(`hair-${hair}`),
    hairDark: v(`hair-dark-${hair}`),
    skin: v(`skin-${skin}`),
    cloth: v(`shirt-${shirt}`),
    clothDark: v(`shirt-dark-${shirt}`),
  };
}

const LINE = v('char-line');
const STK = {
  stroke: LINE,
  strokeWidth: 3,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const;
const HAND_STK = { stroke: LINE, strokeWidth: 2.6, strokeLinejoin: 'round' } as const;

/** 款式換到不同體型時的寬度比例。 */
const WIDTH: Record<BodyType, number> = { M: 1, L: 1.07, F: 0.92 };

function RestArm({ b, side, p }: { b: BodyShape; side: 'L' | 'R'; p: Paint }) {
  const left = side === 'L';
  return (
    <>
      <g {...STK}>
        <path d={left ? b.armL : b.armR} fill={p.cloth} />
        <path d={left ? b.cuffL : b.cuffR} fill="none" strokeWidth={1.6} opacity={0.55} />
      </g>
      <g {...HAND_STK}>
        <path d={left ? b.handL : b.handR} fill={p.skin} />
        <path d={left ? b.thumbL : b.thumbR} fill={p.skin} />
      </g>
    </>
  );
}

const Hand = ({ x, y, r, fill }: { x: number; y: number; r: number; fill: string }) => (
  <circle cx={x} cy={y} r={r} fill={fill} stroke={LINE} strokeWidth={2.6} />
);

/** 手臂、手與手上的東西。 */
function Limbs({ b, pose, p }: { b: BodyShape; pose: Pose; p: Paint }) {
  const { dx } = b;
  if (pose === 'walk') {
    return (
      <>
        <g transform={`rotate(9 ${56 + dx} 113)`}>
          <RestArm b={b} side="L" p={p} />
        </g>
        <g transform={`rotate(9 ${104 - dx} 113)`}>
          <RestArm b={b} side="R" p={p} />
        </g>
      </>
    );
  }
  if (pose === 'laptop') {
    return (
      <>
        <g {...STK}>
          <path d={b.laptopL} fill={p.cloth} />
          <path d={b.laptopR} fill={p.cloth} />
          <rect x={57} y={139} width={46} height={31} rx={3} fill={v('char-laptop')} />
        </g>
        <circle cx={80} cy={154.5} r={3} fill={v('char-laptop-mark')} />
        <Hand x={61} y={165} r={5.4} fill={p.skin} />
        <Hand x={99} y={165} r={5.4} fill={p.skin} />
      </>
    );
  }
  if (pose === 'hold') {
    return (
      <>
        <g {...STK}>
          <path d={b.holdL} fill={p.cloth} />
          <path d={b.holdR} fill={p.cloth} />
        </g>
        <Hand x={71.4} y={149} r={5.2} fill={p.skin} />
        <Hand x={88.6} y={149} r={5.2} fill={p.skin} />
      </>
    );
  }
  if (pose === 'wave') {
    return (
      <>
        <RestArm b={b} side="L" p={p} />
        <g {...STK}>
          <path d={b.waveR} fill={p.cloth} />
        </g>
        <Hand x={127.6 - dx} y={83} r={5.6} fill={p.skin} />
        <path
          d={`M${136 - dx} 75 Q${139.6 - dx} 80 ${138.6 - dx} 85 M${141.6 - dx} 71 Q${146.6 - dx} 79 ${144.6 - dx} 87`}
          fill="none"
          stroke={LINE}
          strokeWidth={1.8}
          strokeLinecap="round"
          opacity={0.5}
        />
      </>
    );
  }
  return (
    <>
      <RestArm b={b} side="L" p={p} />
      <RestArm b={b} side="R" p={p} />
    </>
  );
}

function Legs({
  b,
  pose,
  animate,
  legs,
  feet,
}: {
  b: BodyShape;
  pose: Pose;
  animate: boolean;
  legs: string;
  feet: string;
}) {
  const walk = pose === 'walk';
  return (
    <>
      <g className={animate ? 'hills-step-a' : undefined}>
        <g {...STK} transform={walk ? 'rotate(7 70 182)' : undefined}>
          <path d={b.legL} fill={legs} />
          <path d={FOOT_L} fill={feet} />
        </g>
      </g>
      <g className={animate ? 'hills-step-b' : undefined}>
        <g {...STK} transform={walk ? 'rotate(-7 90 182)' : undefined}>
          <path d={b.legR} fill={legs} />
          <path d={FOOT_R} fill={feet} />
        </g>
      </g>
    </>
  );
}

/** 造型座標（160 × 284）中的整個角色。 */
function Art({ look, pose, animate }: { look: Look; pose: Pose; animate: boolean }) {
  const head = headOf(look);
  const outfit = outfitOf(look);
  const p = paintOf(look);
  const type = HEAD_BODY[head] ?? 'M';
  const b = BODY[type];
  const fit = WIDTH[type] / WIDTH[OUTFIT_BODY[outfit] ?? 'M'];
  return (
    <>
      <ellipse cx={80} cy={250} rx={36} ry={4.6} fill={v('char-shade')} opacity={0.12} />
      <Legs
        b={b}
        pose={pose}
        animate={animate && pose !== 'walk'}
        legs={v(OUTFIT_LEGS[outfit] ?? 'char-pants-a')}
        feet={v(OUTFIT_FEET[outfit] ?? 'char-shoe-dark')}
      />
      <g className={animate ? 'hills-step-body' : undefined}>
        {headBack(head, p)}
        <rect x={74} y={88} width={12} height={20} fill={p.skin} stroke={LINE} strokeWidth={3} />
        <rect x={75.5} y={98} width={9} height={7} fill={v('char-shade')} opacity={0.12} />
        <g {...STK}>
          <path d={b.torso} fill={p.cloth} />
          <path d={b.hem} fill="none" strokeWidth={1.6} opacity={0.55} />
        </g>
        <g
          transform={
            Math.abs(fit - 1) > 0.01
              ? `translate(80 0) scale(${fit} 1) translate(-80 0)`
              : undefined
          }
        >
          {outfitOverlay(outfit, p)}
        </g>
        <Limbs b={b} pose={pose} p={p} />
        {headFront(head, p)}
      </g>
    </>
  );
}

/** 造型座標換到對外座標（100 × 240、雙腳在 y = 224）的比例。 */
const FIT = 0.95;
/** 對外座標中頭部中心與雙手在前時手的高度。 */
export const HEAD_Y = 224 - (246 - 69) * FIT;
export const HOLD_Y = 224 - (246 - 149) * FIT;
/** 對外座標中頭的寬度（含頭髮）。 */
const HEAD_W = 62 * FIT;

/** 以對外座標（100 × 240）畫出整個角色。`sketch` 加上手繪的微微抖動（只在角色舞台與大頭像使用）。 */
export function CharacterArt({
  look,
  pose = 'laptop',
  animate = false,
  sketch = false,
}: {
  look: Look;
  pose?: Pose;
  animate?: boolean;
  sketch?: boolean;
}) {
  return (
    <g filter={sketch ? 'url(#hills-sketch)' : undefined}>
      {sketch && (
        <defs>
          <filter
            id="hills-sketch"
            filterUnits="userSpaceOnUse"
            x={-20}
            y={-20}
            width={140}
            height={280}
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency={0.042}
              numOctaves={2}
              seed={5}
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale={2.2}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      )}
      <g transform={`translate(${50 - 80 * FIT} ${224 - 246 * FIT}) scale(${FIT})`}>
        <Art look={look} pose={pose} animate={animate} />
      </g>
    </g>
  );
}

/** 場景用比例：雙腳在原點、總高約 64 單位。 */
export const SCENE_SCALE = 0.28;
/** 場景座標中頭部中心的 y（給狀態配件定位）。 */
export const SCENE_HEAD_Y = -(226 - HEAD_Y) * SCENE_SCALE;
/** 場景座標中頭的半徑（狀態配件的大小依此換算）。 */
export const SCENE_HEAD_R = (HEAD_W / 2) * SCENE_SCALE;

export function Character({
  look,
  pose = 'laptop',
  animate = false,
}: {
  look: Look;
  pose?: Pose;
  animate?: boolean;
}) {
  return (
    <g transform={`scale(${SCENE_SCALE}) translate(-50 -226)`}>
      <CharacterArt look={look} pose={pose} animate={animate} />
    </g>
  );
}

/** 頭肩像：頭部中心在 (0, -4)、頭寬約 `width`，給圓形裁切使用。 */
export function CharacterHead({ look, width = 20 }: { look: Look; width?: number }) {
  const k = width / HEAD_W;
  return (
    <g transform={`translate(0 -4) scale(${k}) translate(-50 ${-HEAD_Y})`}>
      <CharacterArt look={look} pose="rest" />
    </g>
  );
}
