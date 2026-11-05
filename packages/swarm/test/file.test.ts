import { describe, expect, it } from 'vitest';
import {
  decodeFile,
  encodeFile,
  SwarmError,
  type ByteSource,
  type ShardFetcher,
} from '../src/file';
import { assignNode, fromBase64, type FileManifest } from '../src/manifest';
import { prng } from './helpers';

function memSource(data: Uint8Array): ByteSource {
  return { size: data.length, read: async (o, l) => data.slice(o, o + l) };
}

/** 模擬 8 個儲存節點 */
function memNodes() {
  const store = new Map<string, Uint8Array>();
  let maxInflight = 0;
  let inflight = 0;
  return {
    store,
    get maxInflight() {
      return maxInflight;
    },
    async put(shards: Uint8Array[], ids: string[]) {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 2));
      shards.forEach((s, i) => store.set(ids[i], s.slice()));
      inflight--;
    },
    fetch: (async (ref) => store.get(ref.id) ?? null) as ShardFetcher,
  };
}

async function upload(data: Uint8Array, stripeSize = 1000) {
  const nodes = memNodes();
  const res = await encodeFile(memSource(data), {
    name: '季度報告.pdf',
    stripeSize,
    onStripe: (s) => nodes.put(s.shards, s.ids),
  });
  return { nodes, ...res };
}

async function download(
  m: FileManifest,
  key: Uint8Array,
  fetch: ShardFetcher,
): Promise<Uint8Array> {
  const out = new Uint8Array(m.size);
  await decodeFile(m, key, fetch, { write: async (o, d) => void out.set(d, o) });
  return out;
}

describe('檔案上傳與下載', () => {
  it('多條帶、最後一個條帶較短', async () => {
    const data = prng(11)(4321);
    const { nodes, manifest, fileKey } = await upload(data);
    expect(manifest.stripes).toHaveLength(5);
    expect(manifest.size).toBe(4321);
    expect(await download(manifest, fileKey, nodes.fetch)).toEqual(data);
  });

  it('最多 2 個條帶同時在處理（上傳中 ≤ 1）', async () => {
    const { nodes } = await upload(prng(12)(10_000), 500);
    expect(nodes.maxInflight).toBe(1);
  });

  it('空檔案', async () => {
    const { nodes, manifest, fileKey } = await upload(new Uint8Array(0));
    expect(manifest.stripes).toHaveLength(1);
    expect(await download(manifest, fileKey, nodes.fetch)).toEqual(new Uint8Array(0));
  });

  it('任 3 個節點離線仍可下載', async () => {
    const data = prng(13)(3000);
    const { nodes, manifest, fileKey } = await upload(data);
    const down = new Set([0, 4, 6]);
    const fetch: ShardFetcher = async (ref, _s, i) =>
      down.has(i) ? null : nodes.fetch(ref, _s, i);
    expect(await download(manifest, fileKey, fetch)).toEqual(data);
  });

  it('分片損壞時以同位分片替代', async () => {
    const data = prng(14)(2500);
    const { nodes, manifest, fileKey } = await upload(data);
    const fetch: ShardFetcher = async (ref, s, i) => {
      const d = await nodes.fetch(ref, s, i);
      if (d && i === 1) {
        const bad = d.slice();
        bad[0] ^= 1;
        return bad;
      }
      return d;
    };
    expect(await download(manifest, fileKey, fetch)).toEqual(data);
  });

  it('可用分片少於 5 時回報 UNRECOVERABLE', async () => {
    const { nodes, manifest, fileKey } = await upload(prng(15)(1500));
    const fetch: ShardFetcher = async (ref, s, i) => (i < 4 ? null : nodes.fetch(ref, s, i));
    const err = await download(manifest, fileKey, fetch).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmError);
    expect(err.code).toBe('UNRECOVERABLE');
    expect(err.detail.available).toBe(4);
  });

  it('金鑰錯誤時回報 DECRYPT_FAILED', async () => {
    const { nodes, manifest } = await upload(prng(16)(1200));
    const err = await download(manifest, new Uint8Array(32), nodes.fetch).catch((e) => e);
    expect(err.code).toBe('DECRYPT_FAILED');
  });

  it('manifest 被改短（截斷）時拒絕', async () => {
    const { nodes, manifest, fileKey } = await upload(prng(17)(3500));
    const cut = { ...manifest, size: 2000, stripes: manifest.stripes.slice(0, 2) };
    const err = await download(cut, fileKey, nodes.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmError);
  });

  it('分片分配到節點 (i + fileNonce[0]) mod N', async () => {
    const { manifest } = await upload(prng(18)(100));
    const nonce = fromBase64(manifest.fileNonce);
    manifest.stripes[0].shards.forEach((r, i) => expect(r.node).toBe(assignNode(i, nonce, 8)));
    expect(new Set(manifest.stripes[0].shards.map((r) => r.node)).size).toBe(8);
  });

  it('manifest 不含檔案金鑰', async () => {
    const { manifest, fileKey } = await upload(prng(19)(100));
    const hex = Array.from(fileKey, (b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = btoa(String.fromCharCode(...fileKey));
    const json = JSON.stringify(manifest);
    expect(json).not.toContain(hex);
    expect(json).not.toContain(b64);
  });
});
