/**
 * 整個檔案的上傳端編碼與下載端還原（technical-design §15.2–15.4）。
 *
 * - 逐一讀取條帶，最多同時有 2 個條帶在記憶體中（一個編碼中、一個上傳中）。
 * - 讀檔、上傳、下載都透過介面注入，平台相關程式碼（Tauri fs、HTTP 上傳、.partial 檔）不在本套件內。
 */
import { assignNode, fromBase64, toBase64, type FileManifest, type ShardRef } from './manifest';
import {
  DATA_SHARDS,
  DEFAULT_STRIPE_SIZE,
  TOTAL_SHARDS,
  decodeStripe,
  encodeStripe,
  generateFileSecrets,
  importFileKey,
  sha256Hex,
  shardSize,
  type EncodedStripe,
  type StripeContext,
} from './stripe';

export type SwarmErrorCode = 'UNRECOVERABLE' | 'DECRYPT_FAILED' | 'BAD_MANIFEST' | 'READ_FAILED';

export class SwarmError extends Error {
  constructor(
    readonly code: SwarmErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SwarmError';
  }
}

/** 可隨機讀取的資料來源（Tauri fs FileHandle、Blob、Node fs 皆可包裝）。 */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** 可依位置寫入的輸出（平台端負責寫入 .partial 並在完成後改名）。 */
export interface ByteSink {
  write(offset: number, data: Uint8Array): Promise<void>;
}

export interface EncodeOptions {
  name: string;
  mime?: string;
  mtime?: string;
  fileId?: string;
  stripeSize?: number;
  nodeCount?: number;
  /** 測試用：固定金鑰與 nonce */
  secrets?: { rawKey: Uint8Array; fileNonce: Uint8Array };
  /** 每個條帶編碼完成後呼叫；回傳的 Promise 完成前，最多再編碼一個條帶。 */
  onStripe(stripe: EncodedStripe, nodes: number[]): Promise<void>;
  onProgress?(doneBytes: number, totalBytes: number): void;
}

export interface EncodeResult {
  manifest: FileManifest;
  fileKey: Uint8Array;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 產生 ULID（48-bit 毫秒時間 + 80-bit 亂數）。 */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(16);
  globalThis.crypto.getRandomValues(rnd);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}

export function stripeCountFor(size: number, stripeSize: number): number {
  return Math.max(1, Math.ceil(size / stripeSize));
}

export async function encodeFile(src: ByteSource, opts: EncodeOptions): Promise<EncodeResult> {
  const stripeSize = opts.stripeSize ?? DEFAULT_STRIPE_SIZE;
  const nodeCount = opts.nodeCount ?? TOTAL_SHARDS;
  const { rawKey, fileNonce } = opts.secrets ?? generateFileSecrets();
  const fileId = opts.fileId ?? ulid();
  const stripeCount = stripeCountFor(src.size, stripeSize);
  const ctx: StripeContext = { key: await importFileKey(rawKey), fileId, fileNonce, stripeCount };
  const nodes = Array.from({ length: TOTAL_SHARDS }, (_, i) => assignNode(i, fileNonce, nodeCount));

  const stripes: FileManifest['stripes'] = [];
  let inflight: Promise<void> | null = null;
  for (let k = 0; k < stripeCount; k++) {
    const offset = k * stripeSize;
    const len = Math.min(stripeSize, src.size - offset);
    let plain: Uint8Array;
    try {
      plain = await src.read(offset, len);
    } catch (e) {
      throw new SwarmError('READ_FAILED', '讀取檔案失敗', { stripe: k, cause: String(e) });
    }
    if (plain.length !== len) throw new SwarmError('READ_FAILED', '讀取長度不符', { stripe: k });
    const encoded = await encodeStripe(ctx, k, plain);
    stripes.push({
      payloadLen: encoded.payloadLen,
      shards: encoded.ids.map((id, i) => ({ id, size: encoded.shards[i].length, node: nodes[i] })),
    });
    if (inflight) await inflight;
    inflight = opts.onStripe(encoded, nodes);
    opts.onProgress?.(offset + len, src.size);
  }
  if (inflight) await inflight;

  const manifest: FileManifest = {
    v: 1,
    fileId,
    name: opts.name,
    size: src.size,
    ...(opts.mime ? { mime: opts.mime } : {}),
    ...(opts.mtime ? { mtime: opts.mtime } : {}),
    cipher: 'AES-256-GCM/stripe',
    fileNonce: toBase64(fileNonce),
    stripeSize,
    rs: { data: 5, parity: 3 },
    stripes,
  };
  return { manifest, fileKey: rawKey };
}

/** 取得分片；不存在或失敗時回傳 null（或丟出錯誤，視同遺失）。 */
export type ShardFetcher = (
  ref: ShardRef,
  stripe: number,
  shard: number,
) => Promise<Uint8Array | null>;

export interface DecodeOptions {
  onProgress?(doneBytes: number, totalBytes: number): void;
}

function checkManifest(m: FileManifest): void {
  const expected = stripeCountFor(m.size, m.stripeSize);
  if (m.v !== 1 || m.cipher !== 'AES-256-GCM/stripe' || m.stripes.length !== expected) {
    throw new SwarmError('BAD_MANIFEST', 'manifest 格式錯誤');
  }
  for (const s of m.stripes) {
    if (s.shards.length !== TOTAL_SHARDS) throw new SwarmError('BAD_MANIFEST', '分片數不符');
  }
}

async function fetchVerified(
  fetch: ShardFetcher,
  ref: ShardRef,
  stripe: number,
  shard: number,
): Promise<Uint8Array | null> {
  try {
    const data = await fetch(ref, stripe, shard);
    if (!data || data.length !== ref.size) return null;
    return (await sha256Hex(data)) === ref.id ? data : null;
  } catch {
    return null;
  }
}

export async function decodeFile(
  manifest: FileManifest,
  rawKey: Uint8Array,
  fetch: ShardFetcher,
  sink: ByteSink,
  opts: DecodeOptions = {},
): Promise<void> {
  checkManifest(manifest);
  const ctx: StripeContext = {
    key: await importFileKey(rawKey),
    fileId: manifest.fileId,
    fileNonce: fromBase64(manifest.fileNonce),
    stripeCount: manifest.stripes.length,
  };
  for (let k = 0; k < manifest.stripes.length; k++) {
    const s = manifest.stripes[k];
    const size = shardSize(s.payloadLen);
    if (s.shards.some((r) => r.size !== size)) throw new SwarmError('BAD_MANIFEST', '分片大小不符');
    // 先平行抓 5 個資料分片；不足時依序補抓同位分片
    const got: (Uint8Array | null)[] = new Array(TOTAL_SHARDS).fill(null);
    const data = await Promise.all(
      s.shards.slice(0, DATA_SHARDS).map((r, i) => fetchVerified(fetch, r, k, i)),
    );
    data.forEach((d, i) => (got[i] = d));
    let have = data.filter(Boolean).length;
    for (let p = DATA_SHARDS; p < TOTAL_SHARDS && have < DATA_SHARDS; p++) {
      got[p] = await fetchVerified(fetch, s.shards[p], k, p);
      if (got[p]) have++;
    }
    if (have < DATA_SHARDS) {
      throw new SwarmError('UNRECOVERABLE', '可用分片不足，無法還原', {
        stripe: k,
        available: have,
      });
    }
    let plain: Uint8Array;
    try {
      plain = await decodeStripe(ctx, k, s.payloadLen, got);
    } catch {
      throw new SwarmError('DECRYPT_FAILED', '解密或驗證失敗', { stripe: k });
    }
    const expectedLen = Math.min(manifest.stripeSize, manifest.size - k * manifest.stripeSize);
    if (plain.length !== Math.max(0, expectedLen)) {
      throw new SwarmError('BAD_MANIFEST', '條帶長度不符', { stripe: k });
    }
    await sink.write(k * manifest.stripeSize, plain);
    opts.onProgress?.(Math.min(manifest.size, (k + 1) * manifest.stripeSize), manifest.size);
  }
}
