import { describe, expect, it } from 'vitest';
import { periodsOfYmd } from './goals-utils';
import {
  columns,
  dayCol,
  dueOfCol,
  monthOfWeek,
  packRows,
  periodOfCol,
  quarterOfMonth,
  shift,
  spanOf,
  startOf,
} from './roadmap-utils';

const p = periodsOfYmd(2026, 11, 11);

describe('roadmap 欄與期間', () => {
  it('年：12 個月，季在 3 個月上', () => {
    const cols = columns('year', p);
    expect(cols).toHaveLength(12);
    expect(cols[3]).toEqual({ key: '2026-04', label: '4', group: 'Q2' });
    expect(spanOf('year', '2026-Q2', cols)).toEqual([3, 5]);
    expect(periodOfCol('year', '2026-08')).toBe('2026-Q3');
  });

  it('季：本季的 ISO 週，月目標橫跨該月的週', () => {
    const cols = columns('quarter', p);
    expect(cols[0]?.key).toBe('2026-W40');
    expect(cols.at(-1)?.key).toBe('2026-W53');
    expect(cols.filter((c) => c.group === '2026-11').map((c) => c.key)).toEqual([
      '2026-W45',
      '2026-W46',
      '2026-W47',
      '2026-W48',
    ]);
    const nov = spanOf('quarter', '2026-11', cols);
    expect(nov && cols[nov[0]]?.key).toBe('2026-W45');
    expect(nov && cols[nov[1]]?.key).toBe('2026-W48');
    expect(periodOfCol('quarter', '2026-W46')).toBe('2026-11');
  });

  it('月與週', () => {
    expect(columns('month', p).map((c) => c.key)).toEqual([
      '2026-W45',
      '2026-W46',
      '2026-W47',
      '2026-W48',
    ]);
    expect(spanOf('month', '2026-W46', columns('month', p))).toEqual([1, 1]);
    const week = columns('week', p);
    expect(week.map((c) => c.key)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      'none',
    ]);
    expect(dayCol(dueOfCol('2026-11-12'), week)).toBe('2026-11-12');
    expect(dayCol(null, week)).toBe('none');
    expect(dayCol(new Date('2026-12-01T10:00').getTime(), week)).toBe('none');
    expect(dueOfCol('none')).toBeNull();
  });

  it('移動期間與錨點', () => {
    expect(shift('year', { y: 2026, m: 11, d: 11 }, 1)).toEqual({ y: 2027, m: 11, d: 1 });
    expect(shift('quarter', { y: 2026, m: 11, d: 11 }, 1)).toEqual({ y: 2027, m: 2, d: 1 });
    expect(shift('month', { y: 2026, m: 1, d: 31 }, -1)).toEqual({ y: 2025, m: 12, d: 1 });
    expect(shift('week', { y: 2026, m: 12, d: 30 }, 1)).toEqual({ y: 2027, m: 1, d: 6 });
    expect(startOf('quarter', '2026-Q4')).toEqual({ y: 2026, m: 10, d: 1 });
    expect(startOf('week', '2026-W46')).toEqual({ y: 2026, m: 11, d: 9 });
    expect(monthOfWeek('2027-W53'.replace('2027', '2026'))).toBe('2026-12');
    expect(quarterOfMonth('2026-07')).toBe('2026-Q3');
  });

  it('不重疊的列', () => {
    expect(
      packRows([
        [0, 2],
        [1, 3],
        [3, 4],
        [5, 5],
      ]),
    ).toEqual([0, 1, 0, 0]);
  });
});
