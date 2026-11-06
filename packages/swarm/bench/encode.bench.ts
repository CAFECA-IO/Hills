/**
 * 前端管線吞吐量基準（technical-design §15.8：每平台 ≥ 50 MB/s、記憶體 < 200 MB）。
 *
 *   pnpm --filter @hills/swarm bench            # 預設 256 MiB
 *   SIZE_MB=1024 pnpm --filter @hills/swarm bench
 *
 * Node 結果只供參考；正式數據以 desktop app 的 /dev/swarm-bench（WKWebView、WebView2）為準。
 */
import { decodeFile, encodeFile, type ShardFetcher } from '../src/file';
import { DEFAULT_STRIPE_SIZE } from '../src/stripe';

const sizeMb = Number(process.env.SIZE_MB ?? 256);
const size = sizeMb * 1024 * 1024;
const block = new Uint8Array(DEFAULT_STRIPE_SIZE);
globalThis.crypto.getRandomValues(block.subarray(0, 65536));
for (let o = 65536; o < block.length; o *= 2) block.copyWithin(o, 0, o);

const store = new Map<string, Uint8Array>();
let peakRss = 0;
let peakLive = 0;
const gc = (globalThis as { gc?: () => void }).gc;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
};
/** 每個條帶完成後強制 GC，量測實際存活的記憶體（需 node --expose-gc） */
const sampleLive = () => {
  if (!gc) return;
  gc();
  const m = process.memoryUsage();
  peakLive = Math.max(peakLive, m.heapUsed + m.arrayBuffers);
};
const timer = setInterval(sample, 20);

const rss0 = process.memoryUsage().rss;
let t = performance.now();
const { manifest, fileKey } = await encodeFile(
  { size, read: async (_o, l) => block.slice(0, l) },
  {
    name: 'bench.bin',
    // 模擬上傳：不保留分片，避免基準本身佔用記憶體
    onStripe: async () => sampleLive(),
  },
);
const encMs = performance.now() - t;
const encPeak = peakRss;

void manifest;
void fileKey;
// 下載基準：另外編碼一個單一條帶（20 MiB）的檔案並完整保存，重複解碼
const one = await encodeFile(
  { size: DEFAULT_STRIPE_SIZE, read: async (_o, l) => block.slice(0, l) },
  {
    name: 'one.bin',
    onStripe: async (s) => s.shards.forEach((sh, i) => store.set(s.ids[i], sh.slice())),
  },
);
const fetch: ShardFetcher = async (ref) => store.get(ref.id) ?? null;
t = performance.now();
const reps = Math.max(1, Math.round(sizeMb / 20));
for (let r = 0; r < reps; r++) {
  await decodeFile(one.manifest, one.fileKey, fetch, { write: async () => {} });
}
const decMs = performance.now() - t;
clearInterval(timer);
sample();

const mbps = (mb: number, ms: number) => +(mb / (ms / 1000)).toFixed(1);
console.log(
  JSON.stringify({
    runtime: `node ${process.version}`,
    sizeMb,
    encodeMBps: mbps(sizeMb, encMs),
    decodeMBps: mbps(reps * 20, decMs),
    encodePeakRssMb: Math.round(encPeak / 1048576),
    encodePeakLiveMb: gc ? Math.round(peakLive / 1048576) : null,
    rssBaselineMb: Math.round(rss0 / 1048576),
    stripes: manifest.stripes.length,
  }),
);
