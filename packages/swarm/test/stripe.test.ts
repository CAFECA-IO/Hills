import { describe, expect, it } from 'vitest';
import {
  DATA_SHARDS,
  decodeStripe,
  encodeStripe,
  generateFileSecrets,
  importFileKey,
  sha256Hex,
  type StripeContext,
} from '../src/stripe';
import { prng } from './helpers';

async function ctx(over: Partial<StripeContext> = {}): Promise<StripeContext> {
  const { rawKey, fileNonce } = generateFileSecrets();
  return {
    key: await importFileKey(rawKey),
    fileId: '01JTEST0000000000000000000',
    fileNonce,
    stripeCount: 3,
    ...over,
  };
}

describe('條帶加密與編碼', () => {
  it('往返還原，且分片 ID 為 SHA-256', async () => {
    const c = await ctx();
    const plain = prng(7)(10_001);
    const e = await encodeStripe(c, 1, plain);
    expect(e.payloadLen).toBe(plain.length + 16);
    expect(e.shards).toHaveLength(8);
    expect(new Set(e.shards.map((s) => s.length)).size).toBe(1);
    expect(e.ids[3]).toBe(await sha256Hex(e.shards[3]));
    const back = await decodeStripe(c, 1, e.payloadLen, [
      null,
      e.shards[1],
      null,
      e.shards[3],
      e.shards[4],
      e.shards[5],
      null,
      e.shards[7],
    ]);
    expect(back).toEqual(plain);
  });

  it('密文不含明文（不同 IV 下相同內容產生不同分片）', async () => {
    const c = await ctx();
    const plain = new Uint8Array(4096).fill(0x41);
    const a = await encodeStripe(c, 0, plain);
    const b = await encodeStripe(c, 1, plain);
    expect(a.ids[0]).not.toBe(b.ids[0]);
  });

  it('竄改資料分片時解密失敗', async () => {
    const c = await ctx();
    const e = await encodeStripe(c, 0, prng(1)(5000));
    const bad = e.shards.map((s) => s.slice());
    bad[2][10] ^= 0xff;
    await expect(
      decodeStripe(c, 0, e.payloadLen, [...bad.slice(0, DATA_SHARDS), null, null, null]),
    ).rejects.toThrow();
  });

  it('條帶重排（以第 0 條帶的分片解第 1 條帶）失敗', async () => {
    const c = await ctx();
    const e = await encodeStripe(c, 0, prng(2)(3000));
    await expect(decodeStripe(c, 1, e.payloadLen, e.shards)).rejects.toThrow();
  });

  it('截斷（stripeCount 不同）失敗', async () => {
    const c = await ctx();
    const e = await encodeStripe(c, 1, prng(3)(3000));
    await expect(
      decodeStripe({ ...c, stripeCount: 2 }, 1, e.payloadLen, e.shards),
    ).rejects.toThrow();
  });

  it('混用其他檔案（fileId 不同）失敗', async () => {
    const c = await ctx();
    const e = await encodeStripe(c, 0, prng(4)(3000));
    await expect(
      decodeStripe({ ...c, fileId: '01JOTHER000000000000000000' }, 0, e.payloadLen, e.shards),
    ).rejects.toThrow();
  });

  it('空條帶（空檔案）', async () => {
    const c = await ctx({ stripeCount: 1 });
    const e = await encodeStripe(c, 0, new Uint8Array(0));
    expect(e.payloadLen).toBe(16);
    expect(await decodeStripe(c, 0, 16, e.shards)).toEqual(new Uint8Array(0));
  });
});
