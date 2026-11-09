import { describe, expect, it } from 'vitest';
import { BOOT_VARIANTS, compassFrame, compassPoint, COMPASS, pickBoot } from './boot-utils';

describe('pickBoot', () => {
  it('不重複上次，六個都可能出現', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const v = pickBoot('c', i / 50);
      expect(v).not.toBe('c');
      seen.add(v);
    }
    expect(seen.size).toBe(5);
    const all = new Set(Array.from({ length: 60 }, (_, i) => pickBoot(null, i / 60)));
    expect(all.size).toBe(BOOT_VARIANTS.length);
  });

  it('rand 邊界與未知的上次', () => {
    expect(pickBoot('x', 0)).toBe('a');
    expect(pickBoot('f', 0.9999)).toBe('e');
    expect(pickBoot(null, 1)).toBe('f');
  });
});

describe('compassFrame', () => {
  it('團隊方向在正上方、扇形左右對稱', () => {
    const [x, y] = compassPoint(0, 100);
    expect(y).toBeLessThan(COMPASS.cy);
    expect(Math.abs(x - COMPASS.cx)).toBeLessThan(15);
  });

  it('一開始看不見；中段都進入扇形並打勾；最後淡出', () => {
    expect(compassFrame(0).arms.every((a) => a.opacity === 0)).toBe(true);
    const mid = compassFrame(0.8);
    expect(mid.arms.every((a) => a.opacity === 1 && a.ok === 1)).toBe(true);
    expect(mid.mean.opacity).toBe(1);
    expect(mid.stage).toBe(2);
    expect(compassFrame(0.995).arms.every((a) => a.opacity === 0)).toBe(true);
  });
});
