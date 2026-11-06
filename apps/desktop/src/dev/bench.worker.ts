/**
 * WebView 中的檔案管線基準（technical-design §15.8），在 Web Worker 執行以符合實際使用情境。
 */
import { decodeFile, DEFAULT_STRIPE_SIZE, encodeFile, type ShardFetcher } from '@hills/swarm';

interface Req {
  sizeMb: number;
}

type MemoryPerformance = Performance & { memory?: { usedJSHeapSize: number } };

function heapMb(): number | null {
  const m = (performance as MemoryPerformance).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  try {
    const size = e.data.sizeMb * 1024 * 1024;
    const block = new Uint8Array(DEFAULT_STRIPE_SIZE);
    crypto.getRandomValues(block.subarray(0, 65536));
    for (let o = 65536; o < block.length; o *= 2) block.copyWithin(o, 0, o);
    let peakHeap = heapMb();

    let t = performance.now();
    await encodeFile(
      { size, read: async (_o, l) => block.slice(0, l) },
      {
        name: 'bench.bin',
        onStripe: async () => {
          peakHeap = Math.max(peakHeap ?? 0, heapMb() ?? 0) || null;
        },
        onProgress: (done, total) =>
          self.postMessage({ type: 'progress', percent: Math.round((done / total) * 50) }),
      },
    );
    const encMs = performance.now() - t;

    const store = new Map<string, Uint8Array>();
    const one = await encodeFile(
      { size: DEFAULT_STRIPE_SIZE, read: async (_o, l) => block.slice(0, l) },
      {
        name: 'one.bin',
        onStripe: async (s) => s.shards.forEach((sh, i) => store.set(s.ids[i], sh.slice())),
      },
    );
    const fetch: ShardFetcher = async (ref) => store.get(ref.id) ?? null;
    const reps = Math.max(1, Math.round(e.data.sizeMb / 20));
    t = performance.now();
    for (let r = 0; r < reps; r++) {
      await decodeFile(one.manifest, one.fileKey, fetch, { write: async () => {} });
      self.postMessage({ type: 'progress', percent: 50 + Math.round(((r + 1) / reps) * 50) });
    }
    const decMs = performance.now() - t;
    const mbps = (mb: number, ms: number) => +(mb / (ms / 1000)).toFixed(1);
    self.postMessage({
      type: 'done',
      result: {
        runtime: navigator.userAgent,
        sizeMb: e.data.sizeMb,
        encodeMBps: mbps(e.data.sizeMb, encMs),
        decodeMBps: mbps(reps * 20, decMs),
        workerPeakHeapMb: peakHeap,
      },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};
