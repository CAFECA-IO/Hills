/**
 * Web Worker 入口：在背景執行緒加密與編碼條帶，避免阻塞 UI（technical-design §15.2）。
 *
 * 主執行緒：
 *   const w = new Worker(new URL('@hills/swarm/worker', import.meta.url), { type: 'module' });
 *   w.postMessage({ type: 'encode', id, rawKey, fileNonce, fileId, stripeCount, index, plaintext }, [plaintext.buffer]);
 * 回應：{ type: 'encoded', id, stripe }（分片以 Transferable 傳回）或 { type: 'error', id, message }
 */
import { encodeStripe, importFileKey, type EncodedStripe } from './stripe';

export interface EncodeRequest {
  type: 'encode';
  id: number;
  rawKey: Uint8Array;
  fileNonce: Uint8Array;
  fileId: string;
  stripeCount: number;
  index: number;
  plaintext: Uint8Array;
}

export type WorkerResponse =
  | { type: 'encoded'; id: number; stripe: EncodedStripe }
  | { type: 'error'; id: number; message: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const keys = new Map<string, Promise<CryptoKey>>();

scope.onmessage = (e) => {
  const req = e.data;
  void (async () => {
    try {
      let key = keys.get(req.fileId);
      if (!key) {
        key = importFileKey(req.rawKey);
        keys.set(req.fileId, key);
      }
      const stripe = await encodeStripe(
        {
          key: await key,
          fileId: req.fileId,
          fileNonce: req.fileNonce,
          stripeCount: req.stripeCount,
        },
        req.index,
        req.plaintext,
      );
      if (req.index === req.stripeCount - 1) keys.delete(req.fileId);
      // 資料分片共用同一個 buffer，只轉移一次
      const buffers = [...new Set(stripe.shards.map((s) => s.buffer))] as ArrayBuffer[];
      scope.postMessage({ type: 'encoded', id: req.id, stripe }, buffers);
    } catch (err) {
      scope.postMessage({ type: 'error', id: req.id, message: String(err) }, []);
    }
  })();
};
