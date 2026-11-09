/**
 * 六個啟動動畫的插畫（design-system §9「啟動動畫」v0.5；keyframes 在 styles/boot.css）。
 * 色彩只用 var(--hills-*)；插畫本身 aria-hidden，名稱與狀態由 BootScreen 提供。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { COMPASS, compassFrame, compassPoint, type BootVariant } from './boot-utils';
import { useMediaQuery } from './hooks';

const v = (name: string) => `var(--hills-${name})`;
const REDUCE = '(prefers-reduced-motion: reduce)';

/** 帶 CSS 自訂屬性的 style（分片的起點、火星的方向）。 */
const vars = (o: Record<string, string>) => o as CSSProperties;

function Sky({
  id,
  top = 'sky-top',
  bottom = 'sky-bottom',
}: {
  id: string;
  top?: string;
  bottom?: string;
}) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={v(top)} />
      <stop offset="1" stopColor={v(bottom)} />
    </linearGradient>
  );
}

// ── A 日出山丘 ────────────────────────────────────────────

function SunriseHills() {
  return (
    <svg width="360" height="220" viewBox="0 0 360 220" aria-hidden="true">
      <defs>
        <Sky id="boot-a-sky" />
        <clipPath id="boot-a-clip">
          <rect width="360" height="220" rx="20" />
        </clipPath>
      </defs>
      <g clipPath="url(#boot-a-clip)">
        <rect width="360" height="220" fill="url(#boot-a-sky)" />
        <g className="boot-a-cloud" fill={v('cloud')} opacity=".9">
          <ellipse cx="40" cy="44" rx="26" ry="9" />
          <ellipse cx="54" cy="38" rx="14" ry="9" />
        </g>
        <ellipse
          className="boot-a-cloud2"
          cx="0"
          cy="70"
          rx="20"
          ry="7"
          fill={v('cloud')}
          opacity=".7"
        />
        <g className="boot-a-sun">
          <circle className="boot-a-halo" cx="252" cy="104" r="40" fill={v('sun-halo')} />
          <circle cx="252" cy="104" r="24" fill={v('sun')} />
        </g>
        <path
          className="boot-a-hill"
          d="M0 150 Q60 104 130 128 T260 118 T360 132 V220 H0 Z"
          fill={v('hill-far')}
        />
        <g className="boot-a-hill boot-a-mid">
          <path d="M0 176 Q90 128 180 158 T360 150 V220 H0 Z" fill={v('hill-mid')} />
          <line
            x1="96"
            y1="146"
            x2="96"
            y2="116"
            stroke={v('muted')}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path className="boot-a-flag" d="M97 116 L118 123 L97 130 Z" fill={v('primary')} />
        </g>
        <path
          className="boot-a-hill boot-a-near"
          d="M0 202 Q110 166 220 190 T360 184 V220 H0 Z"
          fill={v('hill-near')}
        />
      </g>
    </svg>
  );
}

// ── B 登頂小旗 ────────────────────────────────────────────

const TRAIL = 'M70 214 L150 186 L118 150 L198 120 L172 92 L176 66';

function SummitTrail({ still }: { still: boolean }) {
  const nodes: [number, number, string][] = [
    [150, 186, 'boot-b-n1'],
    [118, 150, 'boot-b-n2'],
    [198, 120, 'boot-b-n3'],
  ];
  return (
    <svg width="360" height="240" viewBox="0 0 360 240" aria-hidden="true">
      <defs>
        <Sky id="boot-b-sky" />
        <clipPath id="boot-b-clip">
          <rect width="360" height="240" rx="20" />
        </clipPath>
        <mask id="boot-b-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="360" height="240">
          <path
            className="boot-b-reveal"
            pathLength={100}
            d={TRAIL}
            fill="none"
            stroke="white"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <g clipPath="url(#boot-b-clip)">
        <rect width="360" height="240" fill="url(#boot-b-sky)" />
        <path d="M28 226 L160 64 Q176 46 192 64 L332 226 Z" fill={v('mountain')} />
        <path
          d="M160 64 Q176 46 192 64 L206 81 L192 76 L179 87 L166 74 L148 80 Z"
          fill={v('cloud')}
        />
        <rect x="0" y="210" width="360" height="30" fill={v('hill-near')} />
        <g className="boot-b-fade">
          <path
            d={TRAIL}
            fill="none"
            stroke={v('muted')}
            strokeWidth="2"
            strokeDasharray="3 5"
            strokeLinecap="round"
            strokeLinejoin="round"
            mask="url(#boot-b-mask)"
          />
        </g>
        {nodes.map(([x, y, cls], i) => (
          <g key={cls} className={`boot-b-node ${cls}`}>
            <circle cx={x} cy={y} r="9" fill={v('surface')} stroke={v('primary')} strokeWidth="2" />
            <text
              x={x}
              y={y + 4}
              textAnchor="middle"
              fontSize="10"
              fontWeight="700"
              fill={v('primary')}
            >
              {i + 1}
            </text>
          </g>
        ))}
        <line
          x1="176"
          y1="66"
          x2="176"
          y2="30"
          stroke={v('muted')}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path className="boot-b-flag" d="M177 30 L202 38 L177 46 Z" fill={v('primary')} />
        <g className="boot-b-fade" transform={still ? 'translate(176 66)' : undefined}>
          <circle cx="0" cy="-15" r="5" fill={v('skin-1')} />
          <path d="M-6 -2 Q0 -12 6 -2 Z" fill={v('shirt-2')} />
          {!still && (
            <animateMotion
              dur="4.8s"
              repeatCount="indefinite"
              keyPoints="0;1;1"
              keyTimes="0;0.6;1"
              calcMode="linear"
              path={TRAIL}
            />
          )}
        </g>
      </g>
    </svg>
  );
}

// ── C 方向羅盤（每一格由 compassFrame 計算） ─────────────────

function DirectionCompass({ still }: { still: boolean }) {
  const [t, setT] = useState(0.8);
  useEffect(() => {
    if (still) return;
    let frame = 0;
    let start: number | null = null;
    const loop = (now: number) => {
      if (start === null) start = now;
      setT(((now - start) % 5600) / 5600);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [still]);
  const f = compassFrame(still ? 0.8 : t);
  const { cx, cy, r, squash } = COMPASS;
  const ry = r * squash;
  const [lx, ly] = compassPoint(-45, r);
  const [rx, rgy] = compassPoint(45, r);
  const [tx, ty] = compassPoint(0, r * 0.98);
  const wave = Math.sin(t * 12 * Math.PI) * 2;
  const shirts = ['shirt-0', 'shirt-1', 'shirt-2', 'shirt-3'];
  const tilt = `rotate(-6 ${cx} ${cy})`;
  return (
    <svg width="400" height="260" viewBox="0 0 400 260" aria-hidden="true">
      <defs>
        <clipPath id="boot-c-bust" clipPathUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="11" />
        </clipPath>
      </defs>
      <g transform="translate(200 96)">
        <path d="M-46 30 L-8 -14 Q0 -22 8 -14 L46 30 Z" fill={v('mountain')} />
        <path d="M-8 -14 Q0 -22 8 -14 L13 -8 L5 -10 L0 -5 L-6 -11 L-13 -7 Z" fill={v('cloud')} />
      </g>
      <ellipse
        cx={cx}
        cy={cy + 6}
        rx={r}
        ry={ry}
        transform={`rotate(-6 ${cx} ${cy + 6})`}
        fill={v('drift-floor-edge')}
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={r}
        ry={ry}
        transform={tilt}
        fill={v('drift-floor')}
        stroke={v('border')}
        strokeWidth="1.5"
      />
      <path
        d={`M${cx} ${cy} L${lx} ${ly} A${r} ${ry} -6 0 1 ${rx} ${rgy} Z`}
        fill={v('drift-zone')}
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={r * 0.66}
        ry={ry * 0.66}
        transform={tilt}
        fill="none"
        stroke={v('border')}
        strokeWidth="1.2"
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={r * 0.33}
        ry={ry * 0.33}
        transform={tilt}
        fill="none"
        stroke={v('border')}
        strokeWidth="1.2"
      />
      <ellipse
        cx={cx}
        cy={cy}
        rx={r * f.pulse.scale}
        ry={ry * f.pulse.scale}
        transform={tilt}
        fill="none"
        stroke={v('level-year')}
        strokeWidth="2"
        opacity={f.pulse.opacity}
      />
      <line
        x1={cx}
        y1={cy}
        x2={tx}
        y2={ty}
        stroke={v('level-year')}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <line
        x1={tx}
        y1={ty}
        x2={tx}
        y2={ty - 42}
        stroke={v('muted')}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d={`M${tx + 1} ${ty - 42} L${tx + 27 + wave} ${ty - 34} L${tx + 1} ${ty - 26} Z`}
        fill={v('level-year')}
      />
      <line
        x1={cx}
        y1={cy}
        x2={f.mean.x}
        y2={f.mean.y}
        stroke={v('level-year')}
        strokeWidth="2.5"
        strokeDasharray="3 5"
        strokeLinecap="round"
        opacity={f.mean.opacity}
      />
      {f.arms.map((a, i) => {
        const c = v(shirts[i] ?? 'shirt-0');
        return (
          <g key={i} opacity={a.opacity}>
            <line
              x1={cx}
              y1={cy}
              x2={a.x}
              y2={a.y}
              stroke={c}
              strokeWidth="4"
              strokeLinecap="round"
            />
            <line x1={a.x} y1={a.y} x2={a.x} y2={a.y - 22} stroke={c} strokeWidth="2" />
            <g transform={`translate(${a.px} ${a.py})`}>
              <circle r="14" fill={v('surface')} />
              <circle r="11" fill={c} opacity=".22" />
              <g clipPath="url(#boot-c-bust)">
                <circle cy="-2" r="4.5" fill={v('skin-1')} />
                <path d="M-8 11 Q0 1 8 11 Z" fill={c} />
              </g>
              <circle r="12.5" fill="none" stroke={c} strokeWidth="2" />
              <g opacity={a.ok}>
                <circle
                  cx="10"
                  cy="-10"
                  r="5.5"
                  fill={v('st-online')}
                  stroke={v('surface')}
                  strokeWidth="1.5"
                />
                <path
                  d="M7.6 -10 L9.4 -8.2 L12.4 -11.6"
                  fill="none"
                  stroke={v('surface')}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </g>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r="6" fill={v('text')} />
    </svg>
  );
}

// ── D 知識星座（底色用知識庫星空 token，深淺色相同） ──────────

const STARS: [number, number, number, number][] = [
  [48, 78, 3, 0],
  [74, 60, 2.4, 0.12],
  [100, 84, 4.4, 0.24],
  [80, 112, 2.2, 0.36],
  [50, 120, 2.8, 0.48],
  [150, 52, 2.8, 0.9],
  [184, 38, 5.6, 1.02],
  [214, 58, 3.4, 1.14],
  [200, 92, 4, 1.26],
  [168, 98, 2.4, 1.38],
  [244, 92, 2.8, 1.5],
  [262, 118, 2.6, 1.8],
  [290, 102, 4, 1.92],
  [318, 124, 2.4, 2.04],
  [304, 158, 3.4, 2.16],
  [274, 160, 2.2, 2.28],
];

const DUST: [number, number, number][] = [
  [30, 34, 0],
  [140, 20, -0.7],
  [252, 30, -1.4],
  [330, 70, -2.1],
  [40, 186, -1.1],
  [150, 170, -0.4],
  [236, 182, -1.8],
  [338, 196, -2.5],
];

function KnowledgeStars({ labels }: { labels: [string, string, string] }) {
  return (
    <svg width="360" height="220" viewBox="0 0 360 220" aria-hidden="true">
      <defs>
        <Sky id="boot-d-sky" top="night-top" bottom="night-bottom" />
        <clipPath id="boot-d-clip">
          <rect width="360" height="220" rx="20" />
        </clipPath>
        <linearGradient id="boot-d-tail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={v('star')} stopOpacity="1" />
          <stop offset="1" stopColor={v('star')} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g clipPath="url(#boot-d-clip)">
        <rect width="360" height="220" fill="url(#boot-d-sky)" />
        <g className="boot-d-sky">
          <g fill="none" stroke={v('star-dim')} strokeWidth="1" opacity=".35">
            <circle cx="180" cy="210" r="70" />
            <circle cx="180" cy="210" r="130" strokeDasharray="2 4" />
            <circle cx="180" cy="210" r="190" />
            <line x1="180" y1="210" x2="180" y2="-10" />
            <line x1="180" y1="210" x2="20" y2="20" strokeDasharray="2 4" />
            <line x1="180" y1="210" x2="340" y2="20" strokeDasharray="2 4" />
          </g>
          <g fill={v('star-dim')}>
            {DUST.map(([x, y, d]) => (
              <circle
                key={`${x}-${y}`}
                className="boot-d-dust"
                cx={x}
                cy={y}
                r="1.3"
                style={{ animationDelay: `${d}s` }}
              />
            ))}
          </g>
          <circle className="boot-d-glow" cx="186" cy="64" r="58" fill={v('star-dim')} />
          <g
            fill="none"
            stroke={v('night-text')}
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity=".7"
          >
            <path
              className="boot-d-line"
              pathLength={100}
              d="M48 78 L74 60 L100 84 L80 112 L50 120 Z"
            />
            <path
              className="boot-d-line"
              pathLength={100}
              d="M150 52 L184 38 L214 58 L200 92 L168 98 L150 52 M214 58 L244 92"
              style={{ animationDelay: '0.9s' }}
            />
            <path
              className="boot-d-line"
              pathLength={100}
              d="M262 118 L290 102 L318 124 L304 158 L274 160"
              style={{ animationDelay: '1.8s' }}
            />
          </g>
          <g fill={v('star')}>
            {STARS.map(([x, y, r, d]) => (
              <circle
                key={`${x}-${y}`}
                className="boot-d-star"
                cx={x}
                cy={y}
                r={r}
                style={{ animationDelay: `${d}s` }}
              />
            ))}
          </g>
          <path
            className="boot-d-spark"
            d="M184 26 L186 36 L196 38 L186 40 L184 50 L182 40 L172 38 L182 36 Z"
            fill={v('star')}
            opacity=".85"
          />
          <g
            fontSize="10"
            fontWeight="500"
            fill={v('night-text')}
            textAnchor="middle"
            letterSpacing=".2em"
          >
            <text className="boot-d-label" x="74" y="142">
              {labels[0]}
            </text>
            <text className="boot-d-label" x="196" y="118" style={{ animationDelay: '0.9s' }}>
              {labels[1]}
            </text>
            <text className="boot-d-label" x="290" y="182" style={{ animationDelay: '1.8s' }}>
              {labels[2]}
            </text>
          </g>
        </g>
        <g className="boot-d-meteor">
          <line
            x1="300"
            y1="30"
            x2="340"
            y2="12"
            stroke="url(#boot-d-tail)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="300" cy="30" r="2" fill={v('star')} />
        </g>
      </g>
    </svg>
  );
}

// ── E 加密分片拼合 ─────────────────────────────────────────

const SHARDS: [number, number, number][] = [
  [-130, -40, -25],
  [-90, 60, 18],
  [-60, -70, -12],
  [-20, 80, 30],
  [30, -80, -20],
  [70, 70, 22],
  [110, -50, -30],
  [140, 40, 15],
];

function ShardLock({ caption }: { caption: string }) {
  return (
    <svg width="360" height="200" viewBox="0 0 360 200" aria-hidden="true" overflow="visible">
      <defs>
        {SHARDS.map((_, i) => (
          <clipPath key={i} id={`boot-e-c${i}`} clipPathUnits="userSpaceOnUse">
            <rect x={129 + 12.5 * i} y="30" width="14.5" height="120" />
          </clipPath>
        ))}
        <clipPath id="boot-e-tile" clipPathUnits="userSpaceOnUse">
          <rect x="130" y="40" width="100" height="100" rx="24" />
        </clipPath>
        <g id="boot-e-art">
          <rect x="130" y="40" width="100" height="100" rx="24" fill={v('primary')} />
          <path
            d="M142 126 L170 88 L184 106 L196 92 L220 126 Z"
            fill={v('primary-soft')}
            opacity=".7"
          />
          <path d="M150 126 L178 82 L206 126 Z" fill={v('on-primary')} />
          <line
            x1="178"
            y1="82"
            x2="178"
            y2="56"
            stroke={v('on-primary')}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path d="M179.5 56 L198 62 L179.5 68 Z" fill={v('sun')} />
        </g>
      </defs>
      {SHARDS.map(([dx, dy, r], i) => (
        <g
          key={i}
          className="boot-e-shard"
          style={vars({
            '--dx': `${dx}px`,
            '--dy': `${dy}px`,
            '--r': `${r}deg`,
            animationDelay: `${i * 0.15}s`,
          })}
        >
          <use href="#boot-e-art" clipPath={`url(#boot-e-c${i})`} />
        </g>
      ))}
      <g clipPath="url(#boot-e-tile)">
        <rect
          className="boot-e-shine"
          x="140"
          y="30"
          width="26"
          height="130"
          fill={v('on-primary')}
        />
      </g>
      <g className="boot-e-badge">
        <circle cx="228" cy="138" r="15" fill={v('surface')} />
        <rect x="220" y="137" width="16" height="11" rx="2.5" fill={v('st-online')} />
        <path
          className="boot-e-shackle"
          d="M223.5 137 V132.5 A4.5 4.5 0 0 1 232.5 132.5 V137"
          fill="none"
          stroke={v('st-online')}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
      {SHARDS.map((_, i) => (
        <circle
          key={i}
          className="boot-e-dot"
          cx={145 + 10 * i}
          cy="166"
          r="3.2"
          fill={v('border')}
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
      <text x="180" y="190" textAnchor="middle" fontSize="11" fill={v('muted')}>
        {caption}
      </text>
    </svg>
  );
}

// ── F 營火集合 ────────────────────────────────────────────

const CAMPERS: [number, number, string, number][] = [
  [108, 154, 'shirt-0', 0],
  [252, 154, 'shirt-1', 0.35],
  [138, 128, 'shirt-4', 0.7],
  [222, 128, 'shirt-2', 1.05],
  [180, 106, 'shirt-3', 1.4],
];

function Campfire() {
  return (
    <svg width="360" height="220" viewBox="0 0 360 220" aria-hidden="true">
      <defs>
        <Sky id="boot-f-sky" top="sun-halo" />
        <clipPath id="boot-f-clip">
          <rect width="360" height="220" rx="20" />
        </clipPath>
        <clipPath id="boot-f-bust" clipPathUnits="userSpaceOnUse">
          <circle cx="0" cy="0" r="13" />
        </clipPath>
      </defs>
      <g clipPath="url(#boot-f-clip)">
        <rect width="360" height="220" fill="url(#boot-f-sky)" />
        <path d="M0 150 Q80 112 170 130 T360 122 V220 H0 Z" fill={v('hill-far')} />
        <path d="M0 182 Q100 136 180 138 T360 176 V220 H0 Z" fill={v('hill-near')} />
        <ellipse className="boot-f-glow" cx="180" cy="150" rx="70" ry="26" fill={v('boot-glow')} />
        {CAMPERS.map(([x, y, shirt, d]) => (
          <g key={shirt} className="boot-f-person" style={{ animationDelay: `${d}s` }}>
            <ellipse cx={x} cy={y + 18} rx="14" ry="3.5" fill={v('drift-floor-edge')} />
            <g transform={`translate(${x} ${y})`}>
              <circle r="15" fill={v('surface')} />
              <g clipPath="url(#boot-f-bust)">
                <circle r="13" fill={v('sky-bottom')} />
                <circle cy="-3" r="5.5" fill={v('skin-1')} />
                <path d="M-11 14 Q0 1 11 14 Z" fill={v(shirt)} />
              </g>
            </g>
          </g>
        ))}
        <line
          x1="162"
          y1="166"
          x2="198"
          y2="154"
          stroke={v('boot-log')}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <line
          x1="162"
          y1="154"
          x2="198"
          y2="166"
          stroke={v('boot-log')}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          className="boot-f-flame"
          d="M180 160 C164 152 166 134 174 124 C174 134 180 136 180 128 C182 120 188 116 190 108 C196 122 198 150 180 160 Z"
          fill={v('boot-flame-out')}
        />
        <path
          className="boot-f-flame boot-f-flame2"
          d="M180 160 C170 154 170 142 176 134 C177 140 181 141 182 134 C186 138 190 150 180 160 Z"
          fill={v('boot-flame-mid')}
        />
        <path
          className="boot-f-flame boot-f-flame3"
          d="M180 160 C175 157 175 150 178 146 C179 149 182 149 182 146 C185 150 185 157 180 160 Z"
          fill={v('boot-flame-in')}
        />
        <g fill={v('boot-flame-mid')}>
          {[
            [178, 126, -10, 0],
            [184, 122, 12, 0.5],
            [180, 128, -4, 1],
            [186, 126, 8, 1.5],
          ].map(([x, y, sx, d]) => (
            <circle
              key={d}
              className="boot-f-spark"
              cx={x}
              cy={y}
              r="1.6"
              style={vars({ '--sx': `${sx}px`, animationDelay: `${d}s` })}
            />
          ))}
        </g>
        <g fill={v('st-online')} stroke={v('surface')} strokeWidth="2">
          {CAMPERS.map(([x, y, shirt, d]) => (
            <circle
              key={shirt}
              className="boot-f-on"
              cx={x + 11}
              cy={y - 11}
              r="4.5"
              style={{ animationDelay: `${d}s` }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}

/** 依版本畫出插畫。`labels`：D 的三個分類名；`caption`：E 的說明。 */
export function BootArt({
  variant,
  labels,
  caption,
}: {
  variant: BootVariant;
  labels: [string, string, string];
  caption: string;
}) {
  const still = useMediaQuery(REDUCE);
  switch (variant) {
    case 'a':
      return <SunriseHills />;
    case 'b':
      return <SummitTrail still={still} />;
    case 'c':
      return <DirectionCompass still={still} />;
    case 'd':
      return <KnowledgeStars labels={labels} />;
    case 'e':
      return <ShardLock caption={caption} />;
    default:
      return <Campfire />;
  }
}

/** C 的狀態文字依階段切換；其他版本固定。 */
export function useCompassStage(active: boolean): 0 | 1 | 2 {
  const still = useMediaQuery(REDUCE);
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    if (!active || still) return;
    const started = performance.now();
    const id = setInterval(() => {
      setStage(compassFrame(((performance.now() - started) % 5600) / 5600).stage);
    }, 250);
    return () => clearInterval(id);
  }, [active, still]);
  return active && !still ? stage : 2;
}
