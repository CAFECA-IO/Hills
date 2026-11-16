import { describe, expect, it } from 'vitest';
import type { AskCitation } from './api';
import { cardOf, groupCitations, sectionLabel } from './kb-ask';

const cite = (p: Partial<AskCitation>): AskCitation => ({
  n: 1,
  kind: 'item',
  key: 'k1',
  title: '儀控訊號',
  heading: ['分類', '主題', '儀控訊號', '一級處理'],
  page: null,
  excerpt: '…',
  ...p,
});

describe('參考卡合併（ui-spec v0.55）', () => {
  it('附件段落併入所屬知識的卡片', () => {
    const cs = [
      cite({
        n: 1,
        kind: 'pdf',
        key: 'F1',
        title: '儀控訊號.html',
        owner: 'k1',
        ownerTitle: '儀控訊號',
        heading: ['三級'],
        page: 0,
      }),
      cite({ n: 3 }),
      cite({ n: 5, key: 'k2', title: '縮寫對照' }),
    ];
    const g = groupCitations(cs);
    expect(g.map((x) => x.map((c) => c.n))).toEqual([[3, 1], [5]]);
    expect(cardOf(g[0]![1]!)).toMatchObject({ kind: 'item', key: 'k1', title: '儀控訊號' });
    expect(sectionLabel(g[0]![1]!)).toMatch(/ · 儀控訊號\.html · 三級$/);
    expect(sectionLabel(g[0]![0]!)).toBe('一級處理');
  });
});
