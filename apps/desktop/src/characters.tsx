/**
 * 七種角色（D56；design-system §2.2 v0.7、components「Character、CharacterStage」）：
 * 男性、女性、貓、狗、大象、羊、老虎。無線條、正常人體比例、捧著筆電。
 *
 * 繪製座標：寬 100、高 240，雙腳在 (50, 224)。`Character` 把原點換到兩腳中間、總高 64 單位，
 * 供場景使用；設定頁的角色舞台直接用 `CharacterArt` 放大顯示。只用 token 上色。
 */
import type { Look } from './api';

const v = (name: string) => `var(--hills-${name})`;

export const CHARACTER_KINDS = [
  'man',
  'woman',
  'cat',
  'dog',
  'elephant',
  'sheep',
  'tiger',
] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

export const kindOf = (look: Look): CharacterKind => CHARACTER_KINDS[look.kind ?? 0] ?? 'man';

/** 姿勢：捧筆電、雙手在前（拿碗等）、手放下、舉手（休假）、走路（暫離）。 */
export type Pose = 'laptop' | 'hold' | 'rest' | 'wave' | 'walk';

interface Colors {
  /** 部位 1（頭髮 / 毛色 / 皮膚 / 羊毛） */
  a: string;
  /** 衣服 */
  s: string;
  /** 部位 3（膚色 / 花紋 / 耳朵 / 耳內 / 臉 / 條紋） */
  c: string;
  /** 前臂與脖子 */
  limb: string;
  hand: string;
  foot: string;
}

export function colorsOf(look: Look): Colors {
  const kind = kindOf(look);
  const a = v(`look-${kind}-a-${look.hair}`);
  const c = v(`look-${kind}-c-${look.skin}`);
  const s = v(`shirt-${look.shirt}`);
  const cream = v('char-cream');
  const shoe = v('char-shoe');
  switch (kind) {
    case 'man':
    case 'woman':
      return { a, s, c, limb: c, hand: c, foot: shoe };
    case 'cat':
      return { a, s, c, limb: a, hand: cream, foot: a };
    case 'tiger':
      return { a, s, c, limb: a, hand: cream, foot: cream };
    case 'sheep':
      return { a, s, c, limb: c, hand: c, foot: c };
    default:
      return { a, s, c, limb: a, hand: a, foot: a };
  }
}

const SHADE = v('char-shade');

function Legs({ pose, animate, foot }: { pose: Pose; animate: boolean; foot: string }) {
  const pants = v('char-pants');
  const walk = pose === 'walk';
  return (
    <>
      <g
        className={animate ? 'hills-step-a' : undefined}
        transform={walk ? 'rotate(12 44 122)' : undefined}
      >
        <rect x={39} y={122} width={9.5} height={100} rx={4} fill={pants} />
        <ellipse cx={43} cy={224} rx={6.8} ry={3.5} fill={foot} />
      </g>
      <g
        className={animate ? 'hills-step-b' : undefined}
        transform={walk ? 'rotate(-12 56 122)' : undefined}
      >
        <rect x={51.5} y={122} width={9.5} height={100} rx={4} fill={pants} />
        <ellipse cx={57} cy={224} rx={6.8} ry={3.5} fill={foot} />
      </g>
    </>
  );
}

function Torso({ dress, s }: { dress: boolean; s: string }) {
  if (dress) {
    return (
      <>
        <path d="M33 112 L67 112 L70 134 Q50 138 30 134 Z" fill={s} />
        <path d="M33 55 Q50 49 67 55 L65 118 Q50 121 35 118 Z" fill={s} />
        <path d="M55 51 Q61 52 67 55 L65 118 Q60 120 55 120 Z" fill={SHADE} opacity={0.1} />
        <path d="M57 112 L67 112 L70 134 Q63 136 57 136 Z" fill={SHADE} opacity={0.1} />
      </>
    );
  }
  return (
    <>
      <rect x={33} y={116} width={34} height={12} rx={4} fill={v('char-pants')} />
      <path d="M31 54 Q50 47 69 54 L67 122 Q50 126 33 122 Z" fill={s} />
      <path d="M55 49 Q63 50 69 54 L67 122 Q61 124 55 124 Z" fill={SHADE} opacity={0.1} />
    </>
  );
}

/** 手臂（含袖子、前臂、手）與手上的東西。 */
function Arms({ pose, col }: { pose: Pose; col: Colors }) {
  const { s, limb, hand } = col;
  if (pose === 'wave') {
    return (
      <>
        <path d="M31 55 Q25 54 22 46 L18 34 L26 31 L30 44 L35 52 Z" fill={s} />
        <path d="M69 55 Q75 54 78 46 L82 34 L74 31 L70 44 L65 52 Z" fill={s} />
        <path d="M69 55 Q75 54 78 46 L82 34 L74 31 L70 44 L65 52 Z" fill={SHADE} opacity={0.1} />
        <path d="M18 35 L26 32 L24 18 L17 20 Z" fill={limb} />
        <path d="M82 35 L74 32 L76 18 L83 20 Z" fill={limb} />
        <ellipse cx={20.5} cy={16} rx={4.4} ry={4.6} fill={hand} />
        <ellipse cx={79.5} cy={16} rx={4.4} ry={4.6} fill={hand} />
      </>
    );
  }
  const sleeves = (
    <>
      <path d="M31 55 Q25 58 25 67 L26 94 L34 94 L35 62 Z" fill={s} />
      <path d="M69 55 Q75 58 75 67 L74 94 L66 94 L65 62 Z" fill={s} />
      <path d="M69 55 Q75 58 75 67 L74 94 L66 94 L65 62 Z" fill={SHADE} opacity={0.1} />
    </>
  );
  if (pose === 'rest' || pose === 'walk') {
    const swing = pose === 'walk';
    return (
      <>
        <g transform={swing ? 'rotate(-14 31 56)' : undefined}>
          <path d="M31 55 Q25 58 25 67 L26 94 L34 94 L35 62 Z" fill={s} />
          <path d="M26 92 L34 92 L33.5 114 L26.5 114 Z" fill={limb} />
          <ellipse cx={30} cy={116} rx={4.2} ry={4.6} fill={hand} />
        </g>
        <g transform={swing ? 'rotate(14 69 56)' : undefined}>
          <path d="M69 55 Q75 58 75 67 L74 94 L66 94 L65 62 Z" fill={s} />
          <path d="M69 55 Q75 58 75 67 L74 94 L66 94 L65 62 Z" fill={SHADE} opacity={0.1} />
          <path d="M74 92 L66 92 L66.5 114 L73.5 114 Z" fill={limb} />
          <ellipse cx={70} cy={116} rx={4.2} ry={4.6} fill={hand} />
        </g>
      </>
    );
  }
  return (
    <>
      {sleeves}
      <path d="M26 92 L34 92 L41 104 L35 109 Z" fill={limb} />
      <path d="M74 92 L66 92 L59 104 L65 109 Z" fill={limb} />
      {pose === 'laptop' && (
        <>
          <rect x={33} y={89} width={34} height={24} rx={3} fill={v('char-laptop')} />
          <path
            d="M52 89 L64 89 Q67 89 67 92 L67 110 Q67 113 64 113 L52 113 Z"
            fill={SHADE}
            opacity={0.07}
          />
          <circle cx={50} cy={101} r={2} fill={v('char-laptop-mark')} />
        </>
      )}
      <ellipse cx={36} cy={105} rx={4.2} ry={4.6} fill={hand} />
      <ellipse cx={64} cy={105} rx={4.2} ry={4.6} fill={hand} />
    </>
  );
}

function Neck({ kind, col }: { kind: CharacterKind; col: Colors }) {
  if (kind === 'sheep') {
    return (
      <>
        {[40, 47, 53, 60].map((cx, i) => (
          <circle key={cx} cx={cx} cy={i === 0 || i === 3 ? 50 : 52} r={5} fill={col.a} />
        ))}
      </>
    );
  }
  const wide = kind === 'elephant' ? 12 : kind === 'man' || kind === 'woman' ? 9 : 10;
  return (
    <>
      <rect x={50 - wide / 2} y={37} width={wide} height={14} rx={2.5} fill={col.limb} />
      <rect x={50 - wide / 2} y={44} width={wide} height={5} fill={SHADE} opacity={0.12} />
    </>
  );
}

/** 兩頰與眼睛（多數角色共用）。 */
function Eyes({ y, dx = 4, big = false }: { y: number; dx?: number; big?: boolean }) {
  const eye = v('char-eye');
  return (
    <>
      {big && (
        <>
          <ellipse cx={50 - dx - 1} cy={y} rx={2.2} ry={2.6} fill={v('char-eye-white')} />
          <ellipse cx={50 + dx + 1} cy={y} rx={2.2} ry={2.6} fill={v('char-eye-white')} />
        </>
      )}
      <ellipse cx={50 - dx} cy={y + (big ? 0.4 : 0)} rx={big ? 1.4 : 1.5} ry={1.9} fill={eye} />
      <ellipse cx={50 + dx} cy={y + (big ? 0.4 : 0)} rx={big ? 1.4 : 1.5} ry={1.9} fill={eye} />
    </>
  );
}

function Blush({ y, dx = 7 }: { y: number; dx?: number }) {
  return (
    <>
      <ellipse cx={50 - dx} cy={y} rx={2.2} ry={1.3} fill={v('char-blush')} opacity={0.45} />
      <ellipse cx={50 + dx} cy={y} rx={2.2} ry={1.3} fill={v('char-blush')} opacity={0.45} />
    </>
  );
}

const CAT_MOUTH =
  'M47.6 32.6 Q48.8 33.8 50 32.8 Q51.2 33.8 52.4 32.6 Q51.2 34.8 50 33.9 Q48.8 34.8 47.6 32.6 Z';

function Head({ kind, col }: { kind: CharacterKind; col: Colors }) {
  const { a, c } = col;
  const cream = v('char-cream');
  const nose = v('char-nose');
  switch (kind) {
    case 'man':
      return (
        <>
          <ellipse cx={38.6} cy={27} rx={2.4} ry={3.4} fill={c} />
          <ellipse cx={61.4} cy={27} rx={2.4} ry={3.4} fill={c} />
          <ellipse cx={50} cy={26} rx={11.2} ry={13.5} fill={c} />
          <path d="M50 12.5 a11.2 13.5 0 0 1 0 27 Z" fill={SHADE} opacity={0.06} />
          <path
            d="M37.2 29 C34 18 37.6 8.4 47.6 6.6 C58.4 5.2 66.4 10.4 64.8 20.6 C64.4 24 63.4 27 62.6 29.2 C61.8 23.4 59.6 19.6 55.6 18.4 C51.4 20.8 45 21.4 40.8 19.6 C39.4 22.4 38.7 25.4 38.6 29 Z"
            fill={a}
          />
          <path
            d="M41 12 C45 8.4 52 7.6 57 9.4 C52 9.6 46.4 11 43 14 Z"
            fill={v('cloud')}
            opacity={0.14}
          />
          <path
            d="M44 22.5 Q46.5 21 49 22 L49 23.2 Q46.5 22.6 44 23.8 Z M56 22.5 Q53.5 21 51 22 L51 23.2 Q53.5 22.6 56 23.8 Z"
            fill={a}
          />
          <Eyes y={27} />
          <Blush y={31} />
          <path d="M47.6 33 Q50 35.4 52.4 33 Q50 34.2 47.6 33 Z" fill={v('char-mouth')} />
        </>
      );
    case 'woman':
      return (
        <>
          <path
            d="M34.4 24 C31.4 5.6 68.6 5.6 65.6 24 L69.4 61 Q60 65.4 54.6 58.6 L45.4 58.6 Q40 65.4 30.6 61 Z"
            fill={a}
          />
          <path
            d="M34.4 24 C32.9 14.8 41.45 10.2 50 10.2 L50 58.6 L45.4 58.6 Q40 65.4 30.6 61 Z"
            fill={SHADE}
            opacity={0.16}
          />
          <rect x={46} y={38} width={8} height={13} rx={2} fill={c} />
          <ellipse cx={50} cy={26.5} rx={10.6} ry={13} fill={c} />
          <path d="M50 13.5 a10.6 13 0 0 1 0 26 Z" fill={SHADE} opacity={0.06} />
          <path
            d="M38 29 C35 10 61 4.6 64 21.6 C57 22 50.6 18.4 46.4 13.2 C44.4 19.6 41.4 24.6 38 29 Z"
            fill={a}
          />
          <path
            d="M44.4 23.4 Q46.8 22 49 23 L49 24.1 Q46.8 23.5 44.4 24.7 Z M55.6 23.4 Q53.2 22 51 23 L51 24.1 Q53.2 23.5 55.6 24.7 Z"
            fill={a}
          />
          <Eyes y={27.8} dx={3.8} />
          <Blush y={31.6} dx={6.6} />
          <path d="M47.4 33.2 Q50 36.4 52.6 33.2 Z" fill={v('char-lip')} />
        </>
      );
    case 'cat':
      return (
        <>
          <path
            d="M36.8 25 C35.4 16 36.4 8.6 38.6 5.4 C42.4 7 46 10.6 48.6 15 Z M63.2 25 C64.6 16 63.6 8.6 61.4 5.4 C57.6 7 54 10.6 51.4 15 Z"
            fill={a}
          />
          <path
            d="M39.2 18.6 C38.8 14 39.4 10.6 40.4 9 C42.4 10.4 44.4 12.6 45.8 15 Z M60.8 18.6 C61.2 14 60.6 10.6 59.6 9 C57.6 10.4 55.6 12.6 54.2 15 Z"
            fill={v('char-ear-inner')}
          />
          <ellipse cx={50} cy={26} rx={13} ry={12.6} fill={a} />
          <path
            d="M37.4 28 Q39 36 50 39 Q61 36 62.6 28 Q57 31 54 28 Q52 31.6 50 31 Q48 31.6 46 28 Q43 31 37.4 28 Z"
            fill={cream}
          />
          <path d="M50 13.4 a13 12.6 0 0 1 0 25.2 Z" fill={SHADE} opacity={0.06} />
          <path
            d="M46.4 14 L48 14 L48 18.4 L46.4 18.4 Z M49.2 13.6 L50.8 13.6 L50.8 18.6 L49.2 18.6 Z M52 14 L53.6 14 L53.6 18.4 L52 18.4 Z M37 23.6 L41.6 24.4 L41.6 25.8 L37 25.4 Z M63 23.6 L58.4 24.4 L58.4 25.8 L63 25.4 Z"
            fill={c}
          />
          <Eyes y={25} dx={4.8} big />
          <Blush y={30} dx={8} />
          <path d="M48.4 29.4 Q50 28.6 51.6 29.4 Q51 31 50 31.2 Q49 31 48.4 29.4 Z" fill={nose} />
          <path d={CAT_MOUTH} fill={nose} />
        </>
      );
    case 'dog':
      return (
        <>
          <rect x={38} y={12} width={24} height={27} rx={12} fill={a} />
          <path
            d="M50 12 a12 12 0 0 1 12 12 v3 a12 12 0 0 1 -12 12 Z"
            fill={SHADE}
            opacity={0.06}
          />
          <path
            d="M42.4 27 Q44 37 50 38.4 Q56 37 57.6 27 Q54.6 29 50 29 Q45.4 29 42.4 27 Z"
            fill={cream}
          />
          <path
            d="M45 13.2 C37.4 10.2 30.6 14 30 22.4 C29.6 29.4 32 34.6 35.6 34.4 C38.6 35.2 39.6 30.4 39.8 25.4 C40 20.6 41.6 16.4 45 14.6 Z"
            fill={c}
          />
          <path
            d="M55 13.2 C62.6 10.2 69.4 14 70 22.4 C70.4 29.4 68 34.6 64.4 34.4 C61.4 35.2 60.4 30.4 60.2 25.4 C60 20.6 58.4 16.4 55 14.6 Z"
            fill={c}
          />
          <path
            d="M55 13.2 C62.6 10.2 69.4 14 70 22.4 C70.4 29.4 68 34.6 64.4 34.4 C61.4 35.2 60.4 30.4 60.2 25.4 C60 20.6 58.4 16.4 55 14.6 Z"
            fill={SHADE}
            opacity={0.1}
          />
          <Eyes y={22.6} dx={4.8} />
          <Blush y={27.6} dx={7.6} />
          <path
            d="M47.4 27.4 Q50 26.2 52.6 27.4 Q51.8 29.8 50 30.2 Q48.2 29.8 47.4 27.4 Z"
            fill={nose}
          />
          <path d="M47.6 32.6 Q50 35 52.4 32.6 Q50 33.6 47.6 32.6 Z" fill={v('char-mouth')} />
        </>
      );
    case 'elephant':
      return (
        <>
          <path d="M40 16 C27 11 21 24 24 36 C26 42 34 43 40 37 Z" fill={a} />
          <path d="M60 16 C73 11 79 24 76 36 C74 42 66 43 60 37 Z" fill={a} />
          <path d="M39 20 C31 18 27 26 29 33 C30.6 37 35 37 38.4 33.6 Z" fill={c} />
          <path d="M61 20 C69 18 73 26 71 33 C69.4 37 65 37 61.6 33.6 Z" fill={c} />
          <path d="M60 16 C73 11 79 24 76 36 C74 42 66 43 60 37 Z" fill={SHADE} opacity={0.08} />
          <ellipse cx={50} cy={25} rx={12.4} ry={13} fill={a} />
          <path d="M50 12 a12.4 13 0 0 1 0 26 Z" fill={SHADE} opacity={0.06} />
          <path d="M46.6 30 Q46 42 43 47 Q44.6 49.6 47 48.2 Q52 42 53.4 30 Z" fill={a} />
          <Eyes y={23.4} dx={4.6} />
          <Blush y={28.4} dx={7.6} />
        </>
      );
    case 'sheep':
      return (
        <>
          {(
            [
              [41, 16, 6],
              [48, 11, 6.5],
              [55, 11.4, 6.5],
              [61, 17, 6],
              [37.6, 25, 6],
              [62.4, 25, 6],
              [40, 34, 5.4],
              [60, 34, 5.4],
            ] as const
          ).map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={a} />
          ))}
          <ellipse cx={32} cy={24} rx={5.4} ry={2.6} fill={c} transform="rotate(-24 32 24)" />
          <ellipse cx={68} cy={24} rx={5.4} ry={2.6} fill={c} transform="rotate(24 68 24)" />
          <rect x={42} y={15} width={16} height={25} rx={8} fill={c} />
          <path d="M50 15 a8 8 0 0 1 8 8 v9 a8 8 0 0 1 -8 8 Z" fill={SHADE} opacity={0.1} />
          <circle cx={46} cy={15.4} r={4.4} fill={a} />
          <circle cx={51} cy={13.6} r={5} fill={a} />
          <circle cx={55.6} cy={16} r={4} fill={a} />
          <ellipse cx={46.4} cy={25} rx={1.8} ry={2.1} fill={v('char-eye-white')} />
          <ellipse cx={53.6} cy={25} rx={1.8} ry={2.1} fill={v('char-eye-white')} />
          <ellipse cx={46.6} cy={25.4} rx={1.1} ry={1.4} fill={v('char-eye')} />
          <ellipse cx={53.8} cy={25.4} rx={1.1} ry={1.4} fill={v('char-eye')} />
          <Blush y={30} dx={5.4} />
          <path
            d="M48 33.4 Q50 35.4 52 33.4 Q50 34.4 48 33.4 Z"
            fill={v('char-eye-white')}
            opacity={0.85}
          />
        </>
      );
    case 'tiger':
      return (
        <>
          <circle cx={39} cy={14} r={4.8} fill={a} />
          <circle cx={61} cy={14} r={4.8} fill={a} />
          <circle cx={39} cy={14} r={2.5} fill={cream} />
          <circle cx={61} cy={14} r={2.5} fill={cream} />
          <ellipse cx={50} cy={26} rx={13.4} ry={12.6} fill={a} />
          <path
            d="M38.4 29 Q41 37 50 39 Q59 37 61.6 29 Q57 32 53.4 29 Q52 31.4 50 31 Q48 31.4 46.6 29 Q43 32 38.4 29 Z"
            fill={cream}
          />
          <path d="M50 13.4 a13.4 12.6 0 0 1 0 25.2 Z" fill={SHADE} opacity={0.06} />
          <path
            d="M46.4 13.8 L48 13.8 L47.8 18 L46.6 18 Z M49.2 13.4 L50.8 13.4 L50.6 18.2 L49.4 18.2 Z M52 13.8 L53.6 13.8 L53.4 18 L52.2 18 Z M36.6 23 L41.8 24.2 L41.8 25.6 L36.6 25 Z M37 27.4 L41.4 27.8 L41.4 29.2 L37.4 29 Z M63.4 23 L58.2 24.2 L58.2 25.6 L63.4 25 Z M63 27.4 L58.6 27.8 L58.6 29.2 L62.6 29 Z"
            fill={c}
          />
          <Eyes y={24.6} dx={4.8} big />
          <Blush y={30} dx={8} />
          <path
            d="M48.2 29.2 Q50 28.4 51.8 29.2 Q51.2 31 50 31.3 Q48.8 31 48.2 29.2 Z"
            fill={nose}
          />
          <path d={CAT_MOUTH} fill={nose} />
        </>
      );
  }
}

function Tail({ kind, col }: { kind: CharacterKind; col: Colors }) {
  if (kind === 'cat' || kind === 'tiger') {
    return (
      <>
        <path
          d="M62 124 C80 128 86 112 82 98 C81 94 77 95 78 99 C80 110 76 118 62 118 Z"
          fill={col.a}
        />
        {kind === 'tiger' && (
          <path
            d="M79 104 L83.6 103 L83.6 105.4 L79.4 106.2 Z M80 112 L84.4 112 L84 114.4 L79.6 114.2 Z"
            fill={col.c}
          />
        )}
      </>
    );
  }
  if (kind === 'dog') {
    return (
      <path
        d="M62 122 C74 122 80 112 78 104 C77 100 73 101 74 105 C75 112 70 116 62 116 Z"
        fill={col.a}
      />
    );
  }
  return null;
}

/** 以繪製座標（100 × 240）畫出整個角色。 */
export function CharacterArt({
  look,
  pose = 'laptop',
  animate = false,
}: {
  look: Look;
  pose?: Pose;
  animate?: boolean;
}) {
  const kind = kindOf(look);
  const col = colorsOf(look);
  const dress = kind === 'woman';
  return (
    <g>
      <ellipse cx={50} cy={228} rx={22} ry={4} fill={SHADE} opacity={0.13} />
      <Tail kind={kind} col={col} />
      <Legs pose={pose} animate={animate && pose !== 'walk'} foot={col.foot} />
      <g className={animate ? 'hills-step-body' : undefined}>
        <Torso dress={dress} s={col.s} />
        {kind === 'man' && <path d="M44 49 L50 57 L56 49 Z" fill={SHADE} opacity={0.12} />}
        <Arms pose={pose} col={col} />
        {kind !== 'woman' && <Neck kind={kind} col={col} />}
        <Head kind={kind} col={col} />
      </g>
    </g>
  );
}

/** 場景用比例：雙腳在原點、總高 64 單位（頭頂約在 -63）。 */
export const SCENE_SCALE = 0.28;
/** 場景座標中頭部中心的 y（給狀態配件定位）。 */
export const SCENE_HEAD_Y = -(226 - 26) * SCENE_SCALE;

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

/** 頭肩像：頭部中心在 (0, -4)，給圓形裁切使用。 */
export function CharacterHead({ look }: { look: Look }) {
  return (
    <g transform="scale(0.7) translate(-50 -31.7)">
      <CharacterArt look={look} pose="rest" />
    </g>
  );
}
