import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReedSolomonErasure } from '../src/rs';
import fixture from './fixtures/rs-compat.json';
import { prng } from './helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe(`與 SwarmStorage ${fixture.commit.slice(0, 7)} 輸出一致`, () => {
  const rs = new ReedSolomonErasure(5, 3);
  it.each(fixture.cases)('分片大小 $size', ({ seed, size, data, parity }) => {
    const rnd = prng(seed);
    const shards = [
      ...Array.from({ length: 5 }, () => rnd(size)),
      ...Array.from({ length: 3 }, () => new Uint8Array(size)),
    ];
    expect(shards.slice(0, 5).map(sha)).toEqual(data);
    rs.encode(shards);
    expect(shards.slice(5).map(sha)).toEqual(parity);
  });
});
