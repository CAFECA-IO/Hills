/**
 * 檔案分享引擎（technical-design §15.2–15.5、D35、D36、D39）：
 * - 上傳：Rust 讀取條帶明文 → Web Worker 加密與 RS(8,5) 編碼 → 8 個密文分片交給 Rust 轉送到儲存節點。
 *   最多同時 2 個條帶在記憶體中（一個編碼中、一個上傳中）；可暫停、取消、重新開啟後續傳。
 * - 下載：Rust 取回分片 → 前端驗證 SHA-256、RS 解碼、解密 → 明文交給 Rust 寫入 `.partial`，完成後改名。
 * 檔案金鑰只存在記憶體、CK 加密的訊息與本機加密的續傳紀錄中。
 */
import {
  assignNode,
  decodeFile,
  DEFAULT_STRIPE_SIZE,
  fromBase64,
  generateFileSecrets,
  stripeCountFor,
  SwarmError,
  toBase64,
  TOTAL_SHARDS,
  ulid,
  type EncodedStripe,
  type FileManifest,
  type FolderManifest,
} from '@hills/swarm';
import type { EncodeRequest, WorkerResponse } from '@hills/swarm/worker';
import { api, errorMessage, type FolderPick, type PickedFile } from './api';

/** 單檔上限（feature-plan §5、technical-design §15.6） */
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
/** 訊息中附件 JSON 的安全上限（Rust 端 512 KB） */
const MAX_ATTACHMENTS_JSON = 400 * 1024;

export type Attachment =
  | { type: 'file'; manifest: FileManifest; fileKey: string }
  | {
      type: 'folder';
      name: string;
      totalSize: number;
      fileCount: number;
      manifestRef: FileManifest;
      manifestKey: string;
    };

// ── 附件驗證（訊息來自其他成員，視為不可信資料） ──────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

function isManifest(x: unknown): x is FileManifest {
  return (
    isObj(x) &&
    x.v === 1 &&
    typeof x.fileId === 'string' &&
    typeof x.name === 'string' &&
    typeof x.size === 'number' &&
    x.size >= 0 &&
    typeof x.fileNonce === 'string' &&
    typeof x.stripeSize === 'number' &&
    Array.isArray(x.stripes)
  );
}

export function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Attachment => {
    if (!isObj(a)) return false;
    if (a.type === 'file') return isManifest(a.manifest) && typeof a.fileKey === 'string';
    if (a.type === 'folder') {
      return (
        typeof a.name === 'string' &&
        typeof a.totalSize === 'number' &&
        typeof a.fileCount === 'number' &&
        isManifest(a.manifestRef) &&
        typeof a.manifestKey === 'string'
      );
    }
    return false;
  });
}

export function parseFolderManifest(bytes: Uint8Array): FolderManifest {
  const m: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isObj(m) || m.v !== 1 || typeof m.rootName !== 'string' || !Array.isArray(m.entries)) {
    throw new SwarmError('BAD_MANIFEST', '資料夾清單格式錯誤');
  }
  const entries = m.entries.filter(
    (e): e is FolderManifest['entries'][number] =>
      isObj(e) &&
      typeof e.path === 'string' &&
      (e.kind === 'dir' ||
        (e.kind === 'file' && isManifest(e.manifest) && typeof e.fileKey === 'string')),
  );
  return { v: 1, rootName: m.rootName, createdAt: String(m.createdAt ?? ''), entries };
}

// ── Worker ─────────────────────────────────────────────────

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: WorkerResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./share.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const cb = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      cb?.(e.data);
    };
  }
  return worker;
}

function encodeInWorker(req: Omit<EncodeRequest, 'type' | 'id'>): Promise<EncodedStripe> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) =>
      r.type === 'encoded' ? resolve(r.stripe) : reject(new Error(r.message)),
    );
    getWorker().postMessage({ type: 'encode', id, ...req }, [req.plaintext.buffer]);
  });
}

// ── 上傳工作 ────────────────────────────────────────────────

export interface UploadItem {
  token: string;
  /** 單檔：檔名；資料夾：相對路徑 */
  path: string;
  size: number;
  mtime: number | null;
  fileId: string;
  rawKey: string;
  fileNonce: string;
  done?: { manifest: FileManifest; fileKey: string };
}

export interface UploadJob {
  id: string;
  conv: string;
  kind: 'files' | 'folder';
  title: string;
  folder?: { root: string; dirs: string[] };
  items: UploadItem[];
  totalBytes: number;
  doneBytes: number;
  current: string;
  status: 'running' | 'paused' | 'failed' | 'canceled';
  error: string | null;
  startedAt: number;
  /** 從續傳紀錄恢復：上傳前先查詢節點已有的分片 */
  resumed: boolean;
}

type Listener = () => void;
const jobs = new Map<string, UploadJob>();
const listeners = new Set<Listener>();
const controls = new Map<string, { paused: boolean; canceled: boolean; wake?: () => void }>();
let snapshot: UploadJob[] = [];

function emit() {
  snapshot = [...jobs.values()].map((j) => ({ ...j }));
  listeners.forEach((l) => l());
}

export const uploads = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => snapshot,
};

function newItem(token: string, path: string, size: number, mtime: number | null): UploadItem {
  const { rawKey, fileNonce } = generateFileSecrets();
  return {
    token,
    path,
    size,
    mtime,
    fileId: ulid(),
    rawKey: toBase64(rawKey),
    fileNonce: toBase64(fileNonce),
  };
}

/** 未完成的工作寫入本機加密紀錄（關閉 App 後可續傳）。 */
async function persist() {
  const list = [...jobs.values()].filter((j) => j.status !== 'canceled');
  try {
    await api.saveUploadJobs(
      list.map((j) => ({
        id: j.id,
        tokens: j.items.map((i) => i.token),
        state: { ...j, items: j.items.map((i) => ({ ...i, token: '' })), status: 'paused' },
      })),
    );
  } catch {
    // 續傳紀錄失敗不影響本次上傳
  }
}

export function validateSizes(sizes: number[]): string | null {
  return sizes.some((s) => s > MAX_FILE_SIZE) ? 'tooLarge' : null;
}

export function startFiles(conv: string, files: PickedFile[]): UploadJob {
  const job: UploadJob = {
    id: ulid(),
    conv,
    kind: 'files',
    title: files.length === 1 ? files[0].name : `${files[0].name} +${files.length - 1}`,
    items: files.map((f) => newItem(f.token, f.name, f.size, f.mtime)),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    doneBytes: 0,
    current: '',
    status: 'running',
    error: null,
    startedAt: Date.now(),
    resumed: false,
  };
  run(job);
  return job;
}

export function startFolder(conv: string, pick: FolderPick): UploadJob {
  const files = pick.entries.filter((e) => e.kind === 'file');
  const job: UploadJob = {
    id: ulid(),
    conv,
    kind: 'folder',
    title: pick.root,
    folder: {
      root: pick.root,
      dirs: pick.entries.filter((e) => e.kind === 'dir').map((e) => e.path),
    },
    items: files.map((f) => newItem(f.token, f.path, f.size, f.mtime)),
    totalBytes: pick.totalSize,
    doneBytes: 0,
    current: '',
    status: 'running',
    error: null,
    startedAt: Date.now(),
    resumed: false,
  };
  run(job);
  return job;
}

export function pause(id: string, paused: boolean) {
  const c = controls.get(id);
  const j = jobs.get(id);
  if (!c || !j) return;
  c.paused = paused;
  j.status = paused ? 'paused' : 'running';
  if (!paused) c.wake?.();
  emit();
}

export function cancel(id: string) {
  const c = controls.get(id);
  if (c) {
    c.canceled = true;
    c.wake?.();
  }
  // 已上傳的分片不寫入任何訊息，到期後由節點清除（§15.2）
  jobs.delete(id);
  controls.delete(id);
  emit();
  void persist();
}

export function retry(id: string) {
  const j = jobs.get(id);
  if (!j || j.status !== 'failed') return;
  j.status = 'running';
  j.error = null;
  j.resumed = true;
  run(j);
}

/** 重新開啟 App：讀取未完成的上傳。檔案已不存在的項目會讓整個工作標為失敗。 */
export async function loadPending(): Promise<UploadJob[]> {
  const stored = await api.uploadJobs();
  const out: UploadJob[] = [];
  for (const s of stored) {
    if (jobs.has(s.id) || !isObj(s.state)) continue;
    const j = s.state as unknown as UploadJob;
    if (!Array.isArray(j.items) || j.items.length !== s.tokens.length) continue;
    const missing = s.tokens.some((t) => !t);
    j.items = j.items.map((it, i) => ({ ...it, token: s.tokens[i] ?? '' }));
    j.status = missing ? 'failed' : 'paused';
    j.error = missing ? 'missingFile' : null;
    j.resumed = true;
    jobs.set(j.id, j);
    out.push(j);
  }
  emit();
  return out;
}

export function resume(id: string) {
  const j = jobs.get(id);
  if (!j || controls.has(id)) {
    pause(id, false);
    return;
  }
  j.status = 'running';
  run(j);
}

function run(job: UploadJob) {
  jobs.set(job.id, job);
  const ctl = { paused: false, canceled: false } as {
    paused: boolean;
    canceled: boolean;
    wake?: () => void;
  };
  controls.set(job.id, ctl);
  emit();
  void persist();
  void (async () => {
    try {
      const nodes = await api.storageNodes();
      if (nodes.length === 0) throw new Error('noNodes');
      for (const item of job.items) {
        if (item.done) continue;
        job.current = item.path;
        emit();
        item.done = await uploadItem(job, item, nodes, ctl);
        void persist();
      }
      const attachment = await finish(job, nodes, ctl);
      job.current = '';
      emit();
      await api.sendMessage(job.conv, '', [], [attachment]);
      jobs.delete(job.id);
      controls.delete(job.id);
      emit();
      void persist();
    } catch (e) {
      if (ctl.canceled) return;
      job.status = 'failed';
      job.error = errorMessage(e);
      controls.delete(job.id);
      emit();
      void persist();
    }
  })();
}

async function gate(ctl: { paused: boolean; canceled: boolean; wake?: () => void }) {
  while (ctl.paused && !ctl.canceled) {
    await new Promise<void>((r) => (ctl.wake = r));
  }
  if (ctl.canceled) throw new Error('canceled');
}

/** 上傳一個條帶的 8 個分片（續傳時略過節點已有的分片）。 */
async function uploadStripe(stripe: EncodedStripe, storage: number[], resumed: boolean) {
  await Promise.all(
    stripe.shards.map(async (data, i) => {
      const node = storage[i];
      const id = stripe.ids[i];
      if (resumed) {
        const [has] = await api.hasShards(node, [id]).catch(() => [false]);
        if (has) return;
      }
      await api.putShard(node, id, data);
    }),
  );
}

async function encodeAndUpload(
  job: UploadJob,
  src: { size: number; read: (o: number, l: number) => Promise<Uint8Array> },
  secrets: { fileId: string; rawKey: Uint8Array; fileNonce: Uint8Array },
  name: string,
  mtime: number | null,
  nodes: number[],
  ctl: { paused: boolean; canceled: boolean; wake?: () => void },
  countProgress: boolean,
): Promise<FileManifest> {
  const stripeSize = DEFAULT_STRIPE_SIZE;
  const stripeCount = stripeCountFor(src.size, stripeSize);
  const pos = Array.from({ length: TOTAL_SHARDS }, (_, i) =>
    assignNode(i, secrets.fileNonce, nodes.length),
  );
  const storage = pos.map((p) => nodes[p]);
  const stripes: FileManifest['stripes'] = [];
  let inflight: Promise<void> | null = null;
  for (let k = 0; k < stripeCount; k++) {
    await gate(ctl);
    const offset = k * stripeSize;
    const len = Math.min(stripeSize, src.size - offset);
    const plain = await src.read(offset, len);
    if (plain.length !== len) throw new Error('readFailed');
    const enc = await encodeInWorker({
      rawKey: secrets.rawKey,
      fileNonce: secrets.fileNonce,
      fileId: secrets.fileId,
      stripeCount,
      index: k,
      plaintext: plain,
    });
    stripes.push({
      payloadLen: enc.payloadLen,
      shards: enc.ids.map((id, i) => ({ id, size: enc.shards[i].length, node: storage[i] })),
    });
    if (inflight) await inflight;
    inflight = uploadStripe(enc, storage, job.resumed).then(() => {
      if (countProgress) {
        job.doneBytes += len;
        emit();
      }
    });
  }
  if (inflight) await inflight;
  return {
    v: 1,
    fileId: secrets.fileId,
    name,
    size: src.size,
    ...(mtime ? { mtime: new Date(mtime).toISOString() } : {}),
    cipher: 'AES-256-GCM/stripe',
    fileNonce: toBase64(secrets.fileNonce),
    stripeSize,
    rs: { data: 5, parity: 3 },
    stripes,
  };
}

async function uploadItem(
  job: UploadJob,
  item: UploadItem,
  nodes: number[],
  ctl: { paused: boolean; canceled: boolean; wake?: () => void },
) {
  if (!item.token) throw new Error('missingFile');
  const name = item.path.split('/').pop() ?? item.path;
  const manifest = await encodeAndUpload(
    job,
    { size: item.size, read: (o, l) => api.readStripe(item.token, o, l) },
    { fileId: item.fileId, rawKey: fromBase64(item.rawKey), fileNonce: fromBase64(item.fileNonce) },
    name,
    item.mtime,
    nodes,
    ctl,
    true,
  );
  return { manifest, fileKey: item.rawKey };
}

/** 單檔：每個檔案一個附件；資料夾：FolderManifest 以 manifestKey 加密後上傳，訊息只放參照。 */
async function finish(
  job: UploadJob,
  nodes: number[],
  ctl: { paused: boolean; canceled: boolean; wake?: () => void },
): Promise<Attachment> {
  if (job.kind === 'files') {
    // 多個檔案：第一個附件就是整個工作（每個工作最多 1 個附件，訊息逐檔送出前先合併）
    const atts: Attachment[] = job.items.map((i) => ({
      type: 'file',
      manifest: i.done!.manifest,
      fileKey: i.done!.fileKey,
    }));
    if (JSON.stringify(atts).length > MAX_ATTACHMENTS_JSON) throw new Error('tooManyFiles');
    if (atts.length > 1) {
      // 多檔分享：先送前 n-1 個，最後一個由呼叫端送出
      for (const a of atts.slice(0, -1)) await api.sendMessage(job.conv, '', [], [a]);
    }
    return atts[atts.length - 1];
  }
  const folder: FolderManifest = {
    v: 1,
    rootName: job.folder!.root,
    createdAt: new Date(job.startedAt).toISOString(),
    entries: [
      ...job.folder!.dirs.map((path) => ({ kind: 'dir' as const, path })),
      ...job.items.map((i) => ({
        kind: 'file' as const,
        path: i.path,
        manifest: i.done!.manifest,
        fileKey: i.done!.fileKey,
      })),
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(folder));
  const { rawKey, fileNonce } = generateFileSecrets();
  const ref = await encodeAndUpload(
    job,
    { size: bytes.length, read: async (o, l) => bytes.slice(o, o + l) },
    { fileId: ulid(), rawKey, fileNonce },
    `${folder.rootName}.hills-folder.json`,
    null,
    nodes,
    ctl,
    false,
  );
  return {
    type: 'folder',
    name: folder.rootName,
    totalSize: job.totalBytes,
    fileCount: job.items.length,
    manifestRef: ref,
    manifestKey: toBase64(rawKey),
  };
}

// ── 下載 ────────────────────────────────────────────────────

const fetchShard = (ref: { id: string; node: number }) =>
  api.getShard(ref.node, ref.id).catch(() => null);

/** 解密到記憶體（資料夾清單）。 */
export async function decodeToMemory(manifest: FileManifest, key: string): Promise<Uint8Array> {
  const out = new Uint8Array(manifest.size);
  await decodeFile(manifest, fromBase64(key), fetchShard, {
    write: async (offset, data) => out.set(data, offset),
  });
  return out;
}

export interface DownloadResult {
  /** 實際檔名（與原名不同時列在摘要中） */
  renamed: { from: string; to: string }[];
  /** 最後一個完成的檔案（單檔下載時用於「打開」） */
  last: { path: string; name: string } | null;
}

/** 下載單一檔案到 target 的 path（資料夾下載時為相對路徑，單檔為空字串）。 */
export async function downloadFile(
  manifest: FileManifest,
  key: string,
  token: string,
  path: string,
  onProgress: (done: number) => void,
): Promise<string> {
  try {
    await decodeFile(
      manifest,
      fromBase64(key),
      fetchShard,
      { write: (offset, data) => api.writePartial(token, path, offset, data) },
      { onProgress: (done) => onProgress(done) },
    );
    return await api.finishDownload(token, path, manifest.size);
  } catch (e) {
    await api.abortDownload(token, path).catch(() => undefined);
    throw e;
  }
}

/** 錯誤訊息鍵：分片不足時提示稍後再試（ui-spec「下載」）。 */
export function errorKind(e: unknown): 'unrecoverable' | 'decrypt' | 'other' {
  if (e instanceof SwarmError) {
    if (e.code === 'UNRECOVERABLE') return 'unrecoverable';
    if (e.code === 'DECRYPT_FAILED' || e.code === 'BAD_MANIFEST') return 'decrypt';
  }
  return 'other';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
