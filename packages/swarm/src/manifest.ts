/**
 * FileManifest / FolderManifest（technical-design §15.4、§15.5）。
 * 這些結構只會放在 CK 加密的對話訊息中，或以 manifestKey 加密後上傳，儲存節點看不到明文。
 */

export interface ShardRef {
  /** 分片 SHA-256（小寫 hex），即儲存節點上的物件 ID */
  id: string;
  size: number;
  /** 儲存節點編號 0..N-1 */
  node: number;
}

export interface StripeRef {
  /** 密文 + tag 長度（補齊前） */
  payloadLen: number;
  /** 長度 8：0–4 資料分片、5–7 同位分片 */
  shards: ShardRef[];
}

export interface FileManifest {
  v: 1;
  fileId: string;
  name: string;
  /** 明文大小 */
  size: number;
  mime?: string;
  mtime?: string;
  cipher: 'AES-256-GCM/stripe';
  /** base64，8 bytes */
  fileNonce: string;
  stripeSize: number;
  rs: { data: 5; parity: 3 };
  stripes: StripeRef[];
}

export type FolderEntry =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; manifest: FileManifest; fileKey: string };

export interface FolderManifest {
  v: 1;
  rootName: string;
  createdAt: string;
  entries: FolderEntry[];
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 分片 i 放到節點 (i + fileNonce[0]) mod N（technical-design §15.6）。 */
export function assignNode(shardIndex: number, fileNonce: Uint8Array, nodeCount: number): number {
  if (nodeCount < 1) throw new Error('nodeCount 必須 ≥ 1');
  return (shardIndex + fileNonce[0]) % nodeCount;
}
