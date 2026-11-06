import { describe, expect, it } from 'vitest';
import { decodeFile, encodeFile, type ByteSource, type ShardFetcher } from '../src/file';
import { fromBase64, toBase64, type FolderManifest } from '../src/manifest';
import { generateFileSecrets } from '../src/stripe';
import { prng } from './helpers';

const src = (data: Uint8Array): ByteSource => ({
  size: data.length,
  read: async (o, l) => data.slice(o, o + l),
});

/** 資料夾快照往返（technical-design §15.5、§15.8）：中文檔名、多層目錄、清單以 manifestKey 加密。 */
describe('資料夾快照', () => {
  it('中文、多層目錄的資料夾往返後雜湊一致；任 3 個節點離線仍可還原', async () => {
    const store = new Map<string, { data: Uint8Array; node: number }>();
    const put = async (shards: Uint8Array[], ids: string[], nodes: number[]) => {
      shards.forEach((s, i) => store.set(ids[i], { data: s.slice(), node: nodes[i] }));
    };
    const files: Record<string, Uint8Array> = {
      '首頁/hero@2x.png': prng(1)(5000),
      '首頁/圖示/logo.svg': prng(2)(1200),
      '說明 文件.txt': prng(3)(10),
      '空白.md': new Uint8Array(0),
    };
    const entries: FolderManifest['entries'] = [
      { kind: 'dir', path: '首頁' },
      { kind: 'dir', path: '首頁/圖示' },
    ];
    for (const [path, data] of Object.entries(files)) {
      const { manifest, fileKey } = await encodeFile(src(data), {
        name: path.split('/').pop()!,
        stripeSize: 1000,
        onStripe: (s, nodes) => put(s.shards, s.ids, nodes),
      });
      entries.push({ kind: 'file', path, manifest, fileKey: toBase64(fileKey) });
    }
    const folder: FolderManifest = {
      v: 1,
      rootName: '設計稿',
      createdAt: new Date(0).toISOString(),
      entries,
    };
    const json = new TextEncoder().encode(JSON.stringify(folder));
    const secrets = generateFileSecrets();
    const { manifest: ref } = await encodeFile(src(json), {
      name: '設計稿.hills-folder.json',
      stripeSize: 1000,
      secrets,
      onStripe: (s, nodes) => put(s.shards, s.ids, nodes),
    });
    // 節點 1、4、6 離線
    const down = new Set([1, 4, 6]);
    const fetch: ShardFetcher = async (r) => {
      const s = store.get(r.id);
      return s && !down.has(s.node) ? s.data : null;
    };
    const read = async (m: typeof ref, key: Uint8Array) => {
      const out = new Uint8Array(m.size);
      await decodeFile(m, key, fetch, { write: async (o, d) => void out.set(d, o) });
      return out;
    };
    const back = JSON.parse(
      new TextDecoder().decode(await read(ref, secrets.rawKey)),
    ) as FolderManifest;
    expect(back.rootName).toBe('設計稿');
    expect(back.entries.filter((e) => e.kind === 'dir').map((e) => e.path)).toEqual([
      '首頁',
      '首頁/圖示',
    ]);
    for (const e of back.entries) {
      if (e.kind !== 'file') continue;
      const got = await read(e.manifest, fromBase64(e.fileKey));
      const digest = async (b: Uint8Array) =>
        new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
      expect(await digest(got)).toEqual(await digest(files[e.path]));
    }
    // 清單參照（放在訊息中）不含資料夾內的路徑；路徑與 fileKey 只在加密的清單內
    expect(JSON.stringify(ref)).not.toContain('首頁');
  });
});
