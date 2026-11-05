import { describe, expect, it } from 'vitest';
import { ReedSolomonErasure } from '../src/rs';
import { combinations, prng } from './helpers';

const rs = new ReedSolomonErasure(5, 3);

function encoded(size: number, seed: number): Uint8Array[] {
  const rnd = prng(seed);
  const shards = [
    ...Array.from({ length: 5 }, () => rnd(size)),
    ...Array.from({ length: 3 }, () => new Uint8Array(size)),
  ];
  rs.encode(shards);
  return shards;
}

describe('ReedSolomonErasure(8,5)', () => {
  it.each(combinations(8, 3))('遺失分片 %j 仍可還原', (...lost) => {
    const original = encoded(257, 42 + lost.reduce((a, b) => a * 8 + b, 0));
    const work: (Uint8Array | null)[] = original.map((s, i) =>
      lost.includes(i) ? null : s.slice(),
    );
    rs.reconstruct(work);
    work.forEach((s, i) => expect(s).toEqual(original[i]));
  });

  it('遺失 4 片時拒絕還原', () => {
    const work: (Uint8Array | null)[] = encoded(64, 1);
    work[0] = work[2] = work[5] = work[7] = null;
    expect(() => rs.reconstruct(work)).toThrow(/可用切片不足/);
  });

  it('verify 偵測同位分片被竄改', () => {
    const s = encoded(128, 9);
    expect(rs.verify(s)).toBe(true);
    s[6][3] ^= 1;
    expect(rs.verify(s)).toBe(false);
  });
});
