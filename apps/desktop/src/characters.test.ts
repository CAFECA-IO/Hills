import { describe, expect, it } from 'vitest';
import { headOf, outfitOf, paintOf } from './characters';

describe('character look (D69)', () => {
  it('uses head and outfit when present', () => {
    const look = { kind: 1, hair: 2, shirt: 5, skin: 1, head: 6, outfit: 3 };
    expect(headOf(look)).toBe(6);
    expect(outfitOf(look)).toBe(3);
  });
  it('maps looks without head to the old man / woman', () => {
    expect(headOf({ kind: 0, hair: 0, shirt: 0, skin: 0 })).toBe(0);
    expect(headOf({ kind: 1, hair: 0, shirt: 0, skin: 0 })).toBe(4);
    expect(outfitOf({ kind: 1, hair: 0, shirt: 0, skin: 0 })).toBe(4);
  });
  it('keeps out-of-range values inside the palette', () => {
    const look = { kind: 0, hair: 9, shirt: -1, skin: 6, head: 11, outfit: 8 };
    expect(headOf(look)).toBe(3);
    expect(outfitOf(look)).toBe(0);
    expect(paintOf(look)).toMatchObject({
      hair: 'var(--hills-hair-3)',
      cloth: 'var(--hills-shirt-5)',
      skin: 'var(--hills-skin-0)',
    });
  });
});
