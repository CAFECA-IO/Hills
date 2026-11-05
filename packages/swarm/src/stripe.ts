/**
 * 單一條帶的加密 / 編碼與還原（technical-design §15.2、§15.3）。
 *
 * 加密：AES-256-GCM（WebCrypto），每個條帶各自 IV 與 tag
 *   IV  = fileNonce(8 B) ‖ uint32_be(index)
 *   AAD = utf8(fileId) ‖ uint32_be(index) ‖ uint32_be(stripeCount)
 *   payload = ciphertext ‖ tag(16 B)
 * 編碼：payload 以 0 補齊到 5 的倍數 → 5 個資料分片 → RS(8,5) 產生 3 個同位分片。
 *
 * 只使用 WebCrypto 與 Uint8Array，可在瀏覽器、Web Worker、Tauri WebView 與 Node 執行。
 */
import { ReedSolomonErasure } from './rs';

export const DATA_SHARDS = 5;
export const PARITY_SHARDS = 3;
export const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;
export const DEFAULT_STRIPE_SIZE = 20 * 1024 * 1024;
export const TAG_LENGTH = 16;
export const FILE_NONCE_LENGTH = 8;

const rs = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);
const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('此環境不支援 WebCrypto');
  return c.subtle;
}

export interface StripeContext {
  key: CryptoKey;
  fileId: string;
  fileNonce: Uint8Array;
  stripeCount: number;
}

export interface EncodedStripe {
  index: number;
  /** 密文 + tag 長度（補齊前） */
  payloadLen: number;
  /** 8 個分片：0–4 為資料、5–7 為同位 */
  shards: Uint8Array[];
  /** 各分片 SHA-256（小寫 hex），作為物件 ID */
  ids: string[];
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function iv(ctx: StripeContext, index: number): Uint8Array<ArrayBuffer> {
  if (ctx.fileNonce.length !== FILE_NONCE_LENGTH) throw new Error('fileNonce 必須是 8 bytes');
  return new Uint8Array(concat(ctx.fileNonce, u32be(index)));
}

function aad(ctx: StripeContext, index: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(concat(encoder.encode(ctx.fileId), u32be(index), u32be(ctx.stripeCount)));
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await subtle().digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

export function shardSize(payloadLen: number): number {
  return Math.ceil(payloadLen / DATA_SHARDS);
}

/** 產生新的檔案金鑰（32 bytes）與 fileNonce（8 bytes）。 */
export function generateFileSecrets(): { rawKey: Uint8Array; fileNonce: Uint8Array } {
  const rawKey = new Uint8Array(32);
  const fileNonce = new Uint8Array(FILE_NONCE_LENGTH);
  globalThis.crypto.getRandomValues(rawKey);
  globalThis.crypto.getRandomValues(fileNonce);
  return { rawKey, fileNonce };
}

export async function importFileKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== 32) throw new Error('fileKey 必須是 32 bytes');
  return subtle().importKey('raw', rawKey as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** 加密並編碼一個條帶。 */
export async function encodeStripe(
  ctx: StripeContext,
  index: number,
  plaintext: Uint8Array,
): Promise<EncodedStripe> {
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: iv(ctx, index), additionalData: aad(ctx, index), tagLength: 128 },
      ctx.key,
      plaintext as Uint8Array<ArrayBuffer>,
    ),
  );
  const payloadLen = sealed.length;
  const size = shardSize(payloadLen);
  // 資料分片 0–3 直接引用密文 buffer（不複製）；只有最後一片需要補 0，另外配置
  const shards: Uint8Array[] = [];
  for (let i = 0; i < DATA_SHARDS - 1; i++) shards.push(sealed.subarray(i * size, (i + 1) * size));
  const last = new Uint8Array(size);
  last.set(sealed.subarray((DATA_SHARDS - 1) * size));
  shards.push(last);
  for (let i = 0; i < PARITY_SHARDS; i++) shards.push(new Uint8Array(size));
  rs.encode(shards);
  const ids = await Promise.all(shards.map(sha256Hex));
  return { index, payloadLen, shards, ids };
}

/**
 * 由任 5 個分片還原並解密一個條帶。遺失的分片以 null 表示。
 * 呼叫端應先以 manifest 的 SHA-256 驗證每個分片；這裡的 GCM tag 驗證會再擋下任何竄改、
 * 重排或混用其他檔案的條帶。
 */
export async function decodeStripe(
  ctx: StripeContext,
  index: number,
  payloadLen: number,
  shards: (Uint8Array | null)[],
): Promise<Uint8Array> {
  const work = shards.slice();
  rs.reconstruct(work, true);
  const size = shardSize(payloadLen);
  const payload = new Uint8Array(size * DATA_SHARDS);
  for (let i = 0; i < DATA_SHARDS; i++) payload.set(work[i] as Uint8Array, i * size);
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: iv(ctx, index), additionalData: aad(ctx, index), tagLength: 128 },
    ctx.key,
    payload.subarray(0, payloadLen),
  );
  return new Uint8Array(plain);
}
