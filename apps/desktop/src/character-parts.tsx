/**
 * 角色的造型資料（D69；design-system §9 v0.12）：八種髮型、八種服裝款式與三種體型的路徑。
 * 由設計畫布「Hills 角色重繪 · 四男四女」轉出；繪製座標 160 × 284，雙腳在 y = 246。
 * 要調整造型請直接改這個檔案的路徑，組合與姿勢的邏輯在 characters.tsx。
 */
import type { ReactNode } from 'react';

/** 依成員的選擇算出的顏色（都是 token）。 */
export interface Paint {
  hair: string;
  /** 鬍子：比髮色深一階 */
  hairDark: string;
  skin: string;
  cloth: string;
  /** 領口、帽兜：比衣服深一階 */
  clothDark: string;
}

export type BodyType = 'M' | 'L' | 'F';

/** 髮型決定體型：一般（M）、壯碩（L）、纖細（F）。 */
export const HEAD_BODY: readonly BodyType[] = ['M', 'M', 'L', 'M', 'F', 'F', 'F', 'M'];
/** 款式原本所畫的體型（穿到別的體型時依寬度換算）。 */
export const OUTFIT_BODY: readonly BodyType[] = ['M', 'M', 'L', 'M', 'F', 'F', 'F', 'M'];
/** 款式固定的褲子與鞋子顏色（token 名稱）。 */
export const OUTFIT_LEGS: readonly string[] = [
  'char-pants-a',
  'char-pants-b',
  'char-pants-c',
  'char-pants-b',
  'char-pants-a',
  'char-pants-b',
  'char-pants-d',
  'char-pants-a',
];
export const OUTFIT_FEET: readonly string[] = [
  'char-shoe-light',
  'char-shoe-light',
  'char-shoe-brown',
  'char-shoe-dark',
  'char-shoe-dark',
  'char-shoe-red',
  'char-shoe-light',
  'char-shoe-dark',
];

export interface BodyShape {
  torso: string;
  hem: string;
  armL: string;
  armR: string;
  cuffL: string;
  cuffR: string;
  handL: string;
  handR: string;
  thumbL: string;
  thumbR: string;
  legL: string;
  legR: string;
  /** 肩膀相對於一般體型的水平位移 */
  dx: number;
  laptopL: string;
  laptopR: string;
  holdL: string;
  holdR: string;
  waveR: string;
}

export const BODY: Record<BodyType, BodyShape> = {
  M: {
    torso:
      'M60 108 Q80 101 100 108 Q106 110 107 116 L101 150 L100 184 L60 184 L59 150 L53 116 Q54 110 60 108 Z',
    hem: 'M60 177 L100 177',
    armL: 'M55 112 Q46 116 45 130 L43 160 Q42 166 44 170 L52 170 Q54 166 54 160 L58 132 Q60 122 58 114 Z',
    armR: 'M 105 112 Q 114 116 115 130 L 117 160 Q 118 166 116 170 L 108 170 Q 106 166 106 160 L 102 132 Q 100 122 102 114 Z',
    cuffL: 'M43.4 161 L53.6 162',
    cuffR: 'M 116.6 161 L 106.4 162',
    handL: 'M44 169 L52 169 Q54 176 51 181 Q48 184 45 181 Q42 176 44 169 Z',
    handR: 'M 116 169 L 108 169 Q 106 176 109 181 Q 112 184 115 181 Q 118 176 116 169 Z',
    thumbL: 'M52 171 Q56 173.4 54.4 178 L51.6 176.4 Z',
    thumbR: 'M 108 171 Q 104 173.4 105.6 178 L 108.4 176.4 Z',
    legL: 'M62 182 L79 182 L77.6 240 L67 240 Z',
    legR: 'M81 182 L98 182 L93 240 L82.4 240 Z',
    dx: 0,
    laptopL:
      'M 55 112 Q 46 116 45 130 L 43 148 Q 42 158 50 162 L 64 166 L 66 157 L 54 151 L 58 132 Q 60 122 58 114 Z',
    laptopR:
      'M 105 112 Q 114 116 115 130 L 117 148 Q 118 158 110 162 L 96 166 L 94 157 L 106 151 L 102 132 Q 100 122 102 114 Z',
    holdL:
      'M 55 112 Q 46 116 45 130 L 44 144 Q 44 155 52 156 L 72 153 L 72 144 L 56 145 L 58 132 Q 60 122 58 114 Z',
    holdR:
      'M 105 112 Q 114 116 115 130 L 116 144 Q 116 155 108 156 L 88 153 L 88 144 L 104 145 L 102 132 Q 100 122 102 114 Z',
    waveR:
      'M 102 114 Q 107 108 112 104 L 121 86 Q 125 81 130 85 Q 133 89 130 94 L 120 117 Q 114 126 106 124 Z',
  },
  L: {
    torso:
      'M58 108 Q80 100 102 108 Q109 110 110 117 L106 150 Q106 170 103 184 L57 184 Q54 170 54 150 L50 117 Q51 110 58 108 Z',
    hem: 'M56 177 L104 177',
    armL: 'M52 113 Q43 117 42 131 L40 160 Q39 166 41 170 L49 170 Q51 166 51 160 L55 133 Q57 123 55 115 Z',
    armR: 'M 108 113 Q 117 117 118 131 L 120 160 Q 121 166 119 170 L 111 170 Q 109 166 109 160 L 105 133 Q 103 123 105 115 Z',
    cuffL: 'M40.4 161 L50.6 162',
    cuffR: 'M 119.6 161 L 109.4 162',
    handL: 'M41 169 L49 169 Q51 176 48 181 Q45 184 42 181 Q39 176 41 169 Z',
    handR: 'M 119 169 L 111 169 Q 109 176 112 181 Q 115 184 118 181 Q 121 176 119 169 Z',
    thumbL: 'M49 171 Q53 173.4 51.4 178 L48.6 176.4 Z',
    thumbR: 'M 111 171 Q 107 173.4 108.6 178 L 111.4 176.4 Z',
    legL: 'M59 182 L79 182 L77.6 240 L65 240 Z',
    legR: 'M81 182 L101 182 L95 240 L82.4 240 Z',
    dx: -3,
    laptopL:
      'M 52 112 Q 43 116 42 130 L 40 148 Q 39 158 47 162 L 61 166 L 63 157 L 51 151 L 55 132 Q 57 122 55 114 Z',
    laptopR:
      'M 108 112 Q 117 116 118 130 L 120 148 Q 121 158 113 162 L 99 166 L 97 157 L 109 151 L 105 132 Q 103 122 105 114 Z',
    holdL:
      'M 52 112 Q 43 116 42 130 L 41 144 Q 41 155 49 156 L 69 153 L 69 144 L 53 145 L 55 132 Q 57 122 55 114 Z',
    holdR:
      'M 108 112 Q 117 116 118 130 L 119 144 Q 119 155 111 156 L 91 153 L 91 144 L 107 145 L 105 132 Q 103 122 105 114 Z',
    waveR:
      'M 105 114 Q 110 108 115 104 L 124 86 Q 128 81 133 85 Q 136 89 133 94 L 123 117 Q 117 126 109 124 Z',
  },
  F: {
    torso:
      'M63 108 Q80 102 97 108 Q102 110 103 115 L97 146 Q96 152 98 160 L101 184 L59 184 L62 160 Q64 152 63 146 L57 115 Q58 110 63 108 Z',
    hem: 'M60 177 L100 177',
    armL: 'M58 112 Q50 116 49 128 L47 160 Q46 166 48 170 L55 170 Q56.6 166 56.6 160 L60 132 Q61.6 122 60 114 Z',
    armR: 'M 102 112 Q 110 116 111 128 L 113 160 Q 114 166 112 170 L 105 170 Q 103.4 166 103.4 160 L 100 132 Q 98.4 122 100 114 Z',
    cuffL: 'M47.4 161 L56.4 162',
    cuffR: 'M 112.6 161 L 103.6 162',
    handL: 'M48 169 L55 169 Q56.6 175 54 180 Q51.4 183 49 180 Q46.4 175 48 169 Z',
    handR: 'M 112 169 L 105 169 Q 103.4 175 106 180 Q 108.6 183 111 180 Q 113.6 175 112 169 Z',
    thumbL: 'M55 171 Q58.4 173 57 177 L54.6 175.6 Z',
    thumbR: 'M 105 171 Q 101.6 173 103 177 L 105.4 175.6 Z',
    legL: 'M62 182 L79 182 L77 240 L68 240 Z',
    legR: 'M81 182 L98 182 L92 240 L83 240 Z',
    dx: 3,
    laptopL:
      'M 58 112 Q 49 116 48 130 L 46 148 Q 45 158 53 162 L 67 166 L 69 157 L 57 151 L 61 132 Q 63 122 61 114 Z',
    laptopR:
      'M 102 112 Q 111 116 112 130 L 114 148 Q 115 158 107 162 L 93 166 L 91 157 L 103 151 L 99 132 Q 97 122 99 114 Z',
    holdL:
      'M 58 112 Q 49 116 48 130 L 47 144 Q 47 155 55 156 L 75 153 L 75 144 L 59 145 L 61 132 Q 63 122 61 114 Z',
    holdR:
      'M 102 112 Q 111 116 112 130 L 113 144 Q 113 155 105 156 L 85 153 L 85 144 L 101 145 L 99 132 Q 97 122 99 114 Z',
    waveR:
      'M 99 114 Q 104 108 109 104 L 118 86 Q 122 81 127 85 Q 130 89 127 94 L 117 117 Q 111 126 103 124 Z',
  },
};

export const FOOT_L = 'M60 240 Q60 233 69 233 L79 233 L79 246 L63 246 Q58 246 60 240 Z';
export const FOOT_R = 'M 100 240 Q 100 233 91 233 L 81 233 L 81 246 L 97 246 Q 102 246 100 240 Z';

/** 披在身體後面的頭髮（只有長髮的髮型有）。 */
export function headBack(index: number, p: Paint): ReactNode {
  switch (index) {
    case 3:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <path
              d="M47.5 50 C42.5 26 59 7.5 80 7.5 C101 7.5 117.5 26 112.5 50 C117 60 121 70 118 80 C125 86 125 96 118 100 C125 106 123 117 114 119 C110 126 99 126 95 119 L65 119 C61 126 50 126 46 119 C37 117 35 106 42 100 C35 96 35 86 42 80 C39 70 43 60 48 50 Z"
              fill={p.hair}
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path
              d="M41 84 C45 88 45 95 41 99 M43 103 C47 107 47 113 44 117 M119 84 C115 88 115 95 119 99 M117 103 C113 107 113 113 116 117"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />
          </g>
        </>
      );
    case 4:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <path
              d="M42 64 C36 30 58 13 80 13 C102 13 124 30 118 64 C122 96 127 120 122 146 C112 150 104 142 102 130 L58 130 C56 142 48 150 38 146 C33 120 38 96 42 64 Z"
              fill={p.hair}
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
          </g>
        </>
      );
    default:
      return null;
  }
}

/** 臉、五官與前面的頭髮。 */
export function headFront(index: number, p: Paint): ReactNode {
  switch (index) {
    case 0:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="45" cy="68" r="5.4" fill={p.skin} />
              <circle cx="115" cy="68" r="5.4" fill={p.skin} />
              <path
                d="M80 30 C100 30 113 42 115 58 C118 78 104 95 80 95 C56 95 42 78 45 58 C47 42 60 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path d="M45 62 C42 50 45 41 52 36 L57 45 C53 50 51 56 50 63 Z" fill={p.hair} />
              <path
                d="M115 62 C118 50 115 41 108 36 L103 45 C107 50 109 56 110 63 Z"
                fill={p.hair}
              />
              <path
                d="M50 45 C45 26 57 7 80 5 C99 3 116 13 116 34 C116 40 114 44 111 47 C105 40 97 38 88 40 C76 42 62 45 50 45 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M60 40 C62 26 74 15 92 13 M74 41 C79 30 90 23 104 23"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />

            <ellipse
              cx="55"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <ellipse
              cx="105"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <circle cx="63" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="97" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="61.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <circle cx="95.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <ellipse cx="80" cy="75.6" rx="2" ry="1.2" fill="var(--hills-char-nose)" opacity=".8" />

            <path
              d="M56 57.6 L67 56 M93 56 L104 57.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
            <path
              d="M75 83.6 Q80 86 85 83.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>
        </>
      );
    case 1:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="45" cy="68" r="5.4" fill={p.skin} />
              <circle cx="115" cy="68" r="5.4" fill={p.skin} />
              <path
                d="M80 30 C100 30 113 42 115 58 C118 78 104 95 80 95 C56 95 42 78 45 58 C47 42 60 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <path
              d="M47 72 C51 87 62 96 80 96 C98 96 109 87 113 72 C109 80 104 83 98 83 C93 79 87 78 80 78 C73 78 67 79 62 83 C56 83 51 80 47 72 Z"
              fill={p.hair}
              opacity=".2"
            />
            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M44 62 C40 46 42 32 50 26 C48 20 52 14 58 16 C60 10 68 8 72 12 C76 6 86 5 90 10 C96 6 104 9 106 15 C113 14 118 20 115 27 C120 34 119 50 116 62 C113 54 109 48 104 46 C102 50 98 52 95 50 C92 54 86 55 83 51 C79 55 73 55 70 51 C66 54 61 53 59 48 C52 50 47 56 44 62 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M58 22 C62 28 64 36 62 44 M76 14 C78 24 78 36 76 46 M94 16 C94 26 92 36 90 44"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />

            <ellipse
              cx="55"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <ellipse
              cx="105"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <circle cx="63" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="97" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="61.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <circle cx="95.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <ellipse cx="80" cy="75.6" rx="2" ry="1.2" fill="var(--hills-char-nose)" opacity=".8" />

            <path
              d="M56 60 L67 59 M93 59 L104 60"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
            <path
              d="M75 84 Q80 86.4 85 84"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>
        </>
      );
    case 2:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="46" cy="68" r="5.2" fill={p.skin} />
              <circle cx="114" cy="68" r="5.2" fill={p.skin} />
              <path
                d="M80 30 C99 30 111 42 113 58 C115 76 104 97 80 99 C56 97 45 76 47 58 C49 42 61 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M47 64 C46 84 55 106 80 108 C105 106 114 84 113 64 C110 72 105 76 100 76 C94 73 88 72 80 72 C72 72 66 73 60 76 C55 76 50 72 47 64 Z"
                fill={p.hair}
              />
              <path
                d="M47 58 C43 40 50 22 66 15 C81 9 100 12 110 24 C116 32 115 46 113 58 C110 50 106 45 100 43 C88 45 72 47 58 43 C52 47 49 52 47 58 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M64 38 C64 28 70 20 80 17 M80 40 C84 30 92 24 102 24"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".28"
            />

            <ellipse
              cx="56"
              cy="80"
              rx="5.2"
              ry="2.5"
              fill="var(--hills-char-blush)"
              opacity=".6"
            />
            <ellipse
              cx="104"
              cy="80"
              rx="5.2"
              ry="2.5"
              fill="var(--hills-char-blush)"
              opacity=".6"
            />
            <circle cx="64" cy="67" r="4.5" fill="var(--hills-char-eye)" />
            <circle cx="96" cy="67" r="4.5" fill="var(--hills-char-eye)" />
            <circle cx="62.8" cy="65.6" r="1.2" fill="var(--hills-char-eye-white)" />
            <circle cx="94.8" cy="65.6" r="1.2" fill="var(--hills-char-eye-white)" />
            <path
              d="M79 71 Q77.6 76 80 77.6 Q82 77.6 82.4 76.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity=".55"
            />

            <path
              d="M57 57 L68 55.6 M92 55.6 L103 57"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <path
              d="M74.6 85.6 Q80 88.6 85.4 85.6"
              fill="none"
              stroke="var(--hills-char-mouth-light)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>
        </>
      );
    case 3:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="46" cy="68" r="5.2" fill={p.skin} />
              <circle cx="114" cy="68" r="5.2" fill={p.skin} />
              <path
                d="M80 30 C99 30 111 42 113 58 C115 76 104 97 80 99 C56 97 45 76 47 58 C49 42 61 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M69 81 Q74.6 77 80 79.6 Q85.4 77 91 81 Q85.4 84.6 80 82.6 Q74.6 84.6 69 81 Z"
                fill={p.hairDark}
                strokeWidth="2.2"
              />
              <path
                d="M47.5 54.5 C44 34 59 15 80 15 C101 15 116 34 112.5 54.5 C109 47 103 41 95 38 C89 36 84 37 80 40 C76 37 71 36 65 38 C57 41 51 47 47 55 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M66 37 C63 30 65 22 72 17 M80 39 C78.6 31 79.4 23 82 16.6 M94 37 C97 30 95 22 88 17 M55.6 44 C52.6 37 55 28 61.4 22 M104.4 44 C107.4 37 105 28 98.6 22"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />

            <ellipse
              cx="56"
              cy="80"
              rx="4.8"
              ry="2.2"
              fill="var(--hills-char-blush)"
              opacity=".4"
            />
            <ellipse
              cx="104"
              cy="80"
              rx="4.8"
              ry="2.2"
              fill="var(--hills-char-blush)"
              opacity=".4"
            />
            <circle cx="64" cy="66.6" r="4.1" fill="var(--hills-char-eye)" />
            <circle cx="96" cy="66.6" r="4.1" fill="var(--hills-char-eye)" />
            <circle cx="62.9" cy="65.3" r="1.1" fill="var(--hills-char-eye-white)" />
            <circle cx="94.9" cy="65.3" r="1.1" fill="var(--hills-char-eye-white)" />
            <path
              d="M79 70 Q77.4 76 80 78 Q82.4 78 82.8 76.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.7"
              strokeLinecap="round"
              opacity=".6"
            />
            <path
              d="M59 73.4 Q62.4 75 66 74.2 M94 74.2 Q97.6 75 101 73.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity=".22"
            />

            <path
              d="M57 57.6 L68 56.4 M92 56.4 L103 57.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <path
              d="M75.6 87 Q80 89.4 84.4 87"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        </>
      );
    case 4:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M80 30 C100 30 113 42 115 58 C118 78 104 95 80 95 C56 95 42 78 45 58 C47 42 60 30 80 30 Z"
                fill={p.skin}
              />
              <path
                d="M80 20 C60 20 44 38 43 66 C42 92 42 118 47 142 C53 144 57 138 57 130 C53 108 52 86 54 68 C62 60 70 46 74 32 C76 27 78 23 80 20 Z"
                fill={p.hair}
              />
              <path
                d="M80 20 C100 20 116 38 117 66 C118 92 118 118 113 142 C107 144 103 138 103 130 C107 108 108 86 106 68 C98 60 90 46 86 32 C84 27 82 23 80 20 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M48 76 C46 96 47 116 50 134 M112 76 C114 96 113 116 110 134 M66 30 C60 40 54 50 50 58 M94 30 C100 40 106 50 110 58"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />

            <ellipse
              cx="55"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <ellipse
              cx="105"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <circle cx="63" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="97" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="61.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <circle cx="95.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <ellipse cx="80" cy="75.6" rx="2" ry="1.2" fill="var(--hills-char-nose)" opacity=".8" />

            <path
              d="M56 63.6 L59.6 65.6 M104 63.6 L100.4 65.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M58 57 Q62.6 55 67 56.6 M93 56.6 Q97.4 55 102 57"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M75.6 83 Q80 86.4 84.4 83"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>
        </>
      );
    case 5:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <path
              d="M43 62 C37 30 58 14 80 14 C102 14 123 30 117 62 C120 78 118 90 110 98 C104 101 99 97 99 90 L61 90 C61 97 56 101 50 98 C42 90 40 78 43 62 Z"
              fill={p.hair}
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <path
                d="M80 30 C99 30 111 42 113 58 C115 76 104 97 80 99 C56 97 45 76 47 58 C49 42 61 30 80 30 Z"
                fill={p.skin}
              />
              <path
                d="M45 60 C47 38 62 25 82 25 C100 25 113 38 115 58 C108 50 100 46 92 45 C84 52 66 57 45 60 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M60 52 C72 49 84 43 92 33 M54 34 C60 28 68 25 76 24 M48 70 C47 80 48 88 51 94 M112 70 C113 80 112 88 109 94"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".28"
            />
            <circle
              cx="47"
              cy="82"
              r="2.4"
              fill="var(--hills-char-gold)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.4"
            />
            <circle
              cx="113"
              cy="82"
              r="2.4"
              fill="var(--hills-char-gold)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.4"
            />

            <ellipse
              cx="56"
              cy="80"
              rx="5.2"
              ry="2.5"
              fill="var(--hills-char-blush)"
              opacity=".6"
            />
            <ellipse
              cx="104"
              cy="80"
              rx="5.2"
              ry="2.5"
              fill="var(--hills-char-blush)"
              opacity=".6"
            />
            <circle cx="64" cy="67" r="4.5" fill="var(--hills-char-eye)" />
            <circle cx="96" cy="67" r="4.5" fill="var(--hills-char-eye)" />
            <circle cx="62.8" cy="65.6" r="1.2" fill="var(--hills-char-eye-white)" />
            <circle cx="94.8" cy="65.6" r="1.2" fill="var(--hills-char-eye-white)" />
            <path
              d="M79 71 Q77.6 76 80 77.6 Q82 77.6 82.4 76.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.6"
              strokeLinecap="round"
              opacity=".55"
            />

            <path
              d="M57.4 62.6 L61 64.6 M102.6 62.6 L99 64.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M59 56.4 Q63.6 54.6 68 56 M92 56 Q96.4 54.6 101 56.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M75 84.6 Q80 88.4 85 84.6 Q80 86.6 75 84.6 Z"
              fill="var(--hills-char-lip)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </g>
        </>
      );
    case 6:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <circle cx="80" cy="13" r="11.6" fill={p.hair} />
            </g>

            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="45" cy="68" r="5.4" fill={p.skin} />
              <circle cx="115" cy="68" r="5.4" fill={p.skin} />
              <path
                d="M80 30 C100 30 113 42 115 58 C118 78 104 95 80 95 C56 95 42 78 45 58 C47 42 60 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M44 62 C40 36 58 22 80 22 C102 22 120 36 116 62 C112 50 104 43 94 41 C84 39 70 41 58 45 C50 49 46 55 44 62 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M62 29 C70 26 80 26 88 28 M56 37 C66 33 78 32 90 34 M74 8 C78 6 84 6 88 9"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".28"
            />

            <ellipse
              cx="55"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <ellipse
              cx="105"
              cy="81"
              rx="5.7"
              ry="2.9"
              fill="var(--hills-char-blush)"
              opacity=".85"
            />
            <circle cx="63" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="97" cy="68" r="5" fill="var(--hills-char-eye)" />
            <circle cx="61.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <circle cx="95.6" cy="66.4" r="1.3" fill="var(--hills-char-eye-white)" />
            <ellipse cx="80" cy="75.6" rx="2" ry="1.2" fill="var(--hills-char-nose)" opacity=".8" />

            <path
              d="M56 63.6 L59.6 65.6 M104 63.6 L100.4 65.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M57 56 Q62 54 67 56 M93 56 Q98 54 103 56"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M73.6 82.6 Q80 89 86.4 82.6 Z"
              fill="var(--hills-char-eye-white)"
              stroke="var(--hills-char-line)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </g>
        </>
      );
    case 7:
      return (
        <>
          <g transform="translate(80 106) scale(0.84) translate(-80 -106)">
            <g stroke="var(--hills-char-line)" strokeWidth="3" strokeLinejoin="round">
              <circle cx="46" cy="68" r="5.2" fill={p.skin} />
              <circle cx="114" cy="68" r="5.2" fill={p.skin} />
              <path
                d="M80 30 C99 30 111 42 113 58 C115 76 104 97 80 99 C56 97 45 76 47 58 C49 42 61 30 80 30 Z"
                fill={p.skin}
              />
            </g>

            <g
              stroke="var(--hills-char-line)"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <path
                d="M46 64 C41 36 58 17 82 17 C106 17 121 36 114 64 C112 53 109 46 103 42 C96 51 79 56 62 51 C56 53 50 57 46 64 Z"
                fill={p.hair}
              />
            </g>
            <path
              d="M62 50 C74 47 86 41 94 30 M56 30 C62 24 70 21 78 20"
              fill="none"
              stroke="var(--hills-char-eye-white)"
              strokeWidth="1.5"
              strokeLinecap="round"
              opacity=".3"
            />
            <circle
              cx="46.4"
              cy="80"
              r="2.4"
              fill="var(--hills-char-cream)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.4"
            />
            <circle
              cx="113.6"
              cy="80"
              r="2.4"
              fill="var(--hills-char-cream)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.4"
            />

            <ellipse
              cx="56"
              cy="80"
              rx="4.8"
              ry="2.2"
              fill="var(--hills-char-blush)"
              opacity=".4"
            />
            <ellipse
              cx="104"
              cy="80"
              rx="4.8"
              ry="2.2"
              fill="var(--hills-char-blush)"
              opacity=".4"
            />
            <circle cx="64" cy="66.6" r="4.1" fill="var(--hills-char-eye)" />
            <circle cx="96" cy="66.6" r="4.1" fill="var(--hills-char-eye)" />
            <circle cx="62.9" cy="65.3" r="1.1" fill="var(--hills-char-eye-white)" />
            <circle cx="94.9" cy="65.3" r="1.1" fill="var(--hills-char-eye-white)" />
            <path
              d="M79 70 Q77.4 76 80 78 Q82.4 78 82.8 76.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.7"
              strokeLinecap="round"
              opacity=".6"
            />
            <path
              d="M59 73.4 Q62.4 75 66 74.2 M94 74.2 Q97.6 75 101 73.4"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity=".22"
            />

            <path
              d="M57.4 62.4 L61 64.2 M102.6 62.4 L99 64.2"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M59 56.6 Q63.6 54.8 68 56.2 M92 56.2 Q96.4 54.8 101 56.6"
              fill="none"
              stroke="var(--hills-char-line)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M75 86 Q80 89.6 85 86 Q80 88 75 86 Z"
              fill="var(--hills-char-lip)"
              stroke="var(--hills-char-line)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </g>
        </>
      );
    default:
      return null;
  }
}

/** 款式畫在軀幹上的細節（領口、內搭、口袋、鈕扣）。 */
export function outfitOverlay(index: number, p: Paint): ReactNode {
  switch (index) {
    case 0:
      return (
        <>
          <g stroke="var(--hills-char-line)" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M71 105 L89 105 L88 184 L72 184 Z" fill="var(--hills-char-cream)" />
          </g>
          <path
            d="M71 105 Q80 113 89 105 M71 106 L65 124 L72 130 M89 106 L95 124 L88 130"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </>
      );
    case 1:
      return (
        <>
          <path
            d="M67 106 Q80 119 93 106 L96 112 Q80 127 64 112 Z"
            fill={p.clothDark}
            stroke="var(--hills-char-line)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path
            d="M75 119 L75 135 M85 119 L85 133"
            fill="none"
            stroke="var(--hills-char-cream)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M66 158 L94 158 L96 176 L64 176 Z"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            strokeLinejoin="round"
            opacity=".55"
          />
        </>
      );
    case 2:
      return (
        <>
          <g stroke="var(--hills-char-line)" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M68 104 L80 113 L73 125 L62 110 Z" fill={p.cloth} />
            <path d="M92 104 L80 113 L87 125 L98 110 Z" fill={p.cloth} />
          </g>
          <path
            d="M80 114 L80 182"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.8"
            opacity=".6"
          />
          <circle cx="80" cy="130" r="1.6" fill="var(--hills-char-line)" />
          <circle cx="80" cy="146" r="1.6" fill="var(--hills-char-line)" />
          <circle cx="80" cy="162" r="1.6" fill="var(--hills-char-line)" />
          <path
            d="M60 134 L72 134 L72 146 L60 146 Z M88 134 L100 134 L100 146 L88 146 Z"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            strokeLinejoin="round"
            opacity=".55"
          />
        </>
      );
    case 3:
      return (
        <>
          <g stroke="var(--hills-char-line)" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M72 105 L88 105 L87 184 L73 184 Z" fill="var(--hills-char-inner)" />
          </g>
          <path
            d="M72 105 Q80 112 88 105 M72 106 L63 126 L72 134 M88 106 L97 126 L88 134"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </>
      );
    case 4:
      return (
        <>
          <path
            d="M69 105 Q80 112 91 105 L92 113 Q80 120 68 113 Z"
            fill={p.clothDark}
            stroke="var(--hills-char-line)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path
            d="M60 177 L100 177"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            opacity=".55"
          />
        </>
      );
    case 5:
      return (
        <>
          <g stroke="var(--hills-char-line)" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M69 104 L80 112 L74 122 L64 110 Z" fill="var(--hills-char-cream)" />
            <path d="M91 104 L80 112 L86 122 L96 110 Z" fill="var(--hills-char-cream)" />
          </g>
          <path
            d="M80 114 L80 182"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            opacity=".55"
          />
          <circle cx="80" cy="130" r="1.6" fill="var(--hills-char-line)" />
          <circle cx="80" cy="146" r="1.6" fill="var(--hills-char-line)" />
          <circle cx="80" cy="162" r="1.6" fill="var(--hills-char-line)" />
        </>
      );
    case 6:
      return (
        <>
          <path
            d="M69 105 Q80 110 91 105 L92 112 Q80 118 68 112 Z"
            fill="var(--hills-char-cream)"
            stroke="var(--hills-char-line)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path
            d="M80 117 L80 182"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            opacity=".6"
          />
          <path
            d="M60 177 L100 177"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="1.6"
            opacity=".55"
          />
        </>
      );
    case 7:
      return (
        <>
          <g stroke="var(--hills-char-line)" strokeWidth="2.4" strokeLinejoin="round">
            <path d="M70 105 L80 140 L90 105 Z" fill="var(--hills-char-cream)" />
          </g>
          <path
            d="M70 105 L65 130 L80 144 L95 130 L90 105 M80 144 L80 182"
            fill="none"
            stroke="var(--hills-char-line)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="80" cy="156" r="1.8" fill="var(--hills-char-line)" />
        </>
      );
    default:
      return null;
  }
}
