/**
 * 文件理解的前端排程（technical-design §16.20「排程」，D68）：
 * 狀態快取、一次處理一個檔案的佇列，以及掛在 shell 的自動排程。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  api,
  EVENTS,
  listen,
  type DocAiStatus,
  type DocHit,
  type FileEntry,
  type Indexed,
} from './api';
import { t } from './i18n';
import { autoQueue, MAX_BYTES, staleKeys } from './docai-utils';
import { useNodeEvents } from './hooks';
import { decodeToMemory, parseAttachments } from './share';

interface Snapshot {
  status: DocAiStatus | null;
  running: string | null;
  queued: string[];
}

let snap: Snapshot = { status: null, running: null, queued: [] };
const subs = new Set<() => void>();
const queue: FileEntry[] = [];
let pumping = false;
/** 這次執行中取得內容失敗的檔案：自動排程不再重試，使用者可手動「建立索引」 */
const failed = new Set<string>();
let listening = false;

function emit(p: Partial<Snapshot>) {
  snap = { ...snap, ...p };
  subs.forEach((cb) => cb());
}

export async function refreshDocAi(): Promise<void> {
  try {
    emit({ status: await api.docaiStatus() });
  } catch {
    emit({ status: null });
  }
}

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!listening) {
    listening = true;
    void listen<string>(EVENTS.docai, () => void refreshDocAi());
    void refreshDocAi();
  }
  return () => {
    subs.delete(cb);
  };
}

/** 文件理解的狀態、正在處理與排隊中的檔案。 */
export function useDocAi(): Snapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

/** 建立一個檔案的索引：已下載的由 Rust 讀本機檔，否則解密到記憶體再交給 Rust（不落地）。 */
export async function indexFile(f: FileEntry): Promise<Indexed> {
  if (f.downloaded) {
    try {
      return await api.docaiIndexDownloaded(f.key, f.name);
    } catch {
      // 檔案已移動或刪除：改從儲存節點取得
    }
  }
  if (f.size > MAX_BYTES) return api.docaiIndexBytes(f.key, f.name, new Uint8Array(0), f.size);
  const att = parseAttachments([f.attachment])[0];
  if (!att || att.type !== 'file') throw new Error('not a file');
  const bytes = await decodeToMemory(att.manifest, att.fileKey);
  return api.docaiIndexBytes(f.key, f.name, bytes);
}

/** 排入佇列（重複的略過）。`front` = 使用者按的「建立索引」，排到最前面。 */
export function enqueue(f: FileEntry, front = false) {
  if (snap.running === f.key || queue.some((x) => x.key === f.key)) return;
  if (front) failed.delete(f.key);
  else if (failed.has(f.key)) return;
  if (front) queue.unshift(f);
  else queue.push(f);
  emit({ queued: queue.map((x) => x.key) });
  void pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const f = queue.shift()!;
      emit({ running: f.key, queued: queue.map((x) => x.key) });
      try {
        await indexFile(f);
      } catch {
        // 取得內容失敗（分片暫時不足等）：不記錄狀態，這次執行中不再自動重試
        failed.add(f.key);
      }
      await refreshDocAi();
    }
  } finally {
    emit({ running: null, queued: [] });
    pumping = false;
  }
}

/** 重新建立一個檔案的索引（「重建」「再試一次」）。 */
export async function reindex(f: FileEntry) {
  await api.docaiForget(f.key).catch(() => undefined);
  await refreshDocAi();
  enqueue(f, true);
}

const FILE_EVENTS = ['all', 'message', 'doc', 'convs', 'org'];

/** 掛在 shell：功能開啟且就緒時，依「檔案」清單自動排程並清掉看不到的檔案。 */
export function useDocIndexer() {
  const { status } = useDocAi();
  const latest = useRef(status);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    latest.current = status;
  });
  useNodeEvents((name) => {
    if (FILE_EVENTS.includes(name)) setTick((x) => x + 1);
  });
  const ready = status?.ready ?? false;
  const known = status ? Object.keys(status.files).length : 0;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void api
      .listFiles()
      .then((files) => {
        const s = latest.current;
        if (!alive || !s) return;
        for (const key of staleKeys(files, s)) {
          void api
            .docaiForget(key)
            .then(refreshDocAi)
            .catch(() => undefined);
        }
        for (const f of autoQueue(files, s)) enqueue(f);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ready, known, tick]);
}

/** 內容搜尋（D68）：輸入 2 個字以上、文件理解就緒時查詢，300 ms 去抖動。 */
export function useContentHits(query: string, ready: boolean): DocHit[] {
  const [res, setRes] = useState<{ q: string; hits: DocHit[] }>({ q: '', hits: [] });
  const q = query.trim();
  const active = ready && q.length >= 2;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const id = setTimeout(() => {
      api
        .docaiSearch(q, 20)
        .then((hits) => alive && setRes({ q, hits }))
        .catch(() => alive && setRes({ q, hits: [] }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, active]);
  return active && res.q === q ? res.hits : [];
}

export const pageLabel = (h: DocHit) =>
  h.pageFrom === h.pageTo
    ? t('docai.page', { n: h.pageFrom })
    : t('docai.pages', { from: h.pageFrom, to: h.pageTo });
