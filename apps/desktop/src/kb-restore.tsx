/**
 * 匯入 Hills 匯出的知識庫（ui-spec「知識庫 › 匯出 / 匯入」v0.55、technical-design §16.23，D74）：
 * 讀 hills-kb.json → 比對 → 摘要 → 建立分類與主題 → 逐則存入（含附件）→ 重建引用 → 摘要。
 */
import { useEffect, useRef, useState } from 'react';
import { api, type FolderPick, type FolderPickEntry, type KbItem, type KbSnapshot } from './api';
import { formatDate, t } from './i18n';
import {
  MANIFEST,
  parseManifest,
  remapRefs,
  stripFrontMatter,
  type Manifest,
} from './kb-export-utils';
import { readAll } from './kb-import';
import { importedBy, sha256Hex, statusOf, type ImportStatus } from './kb-import-utils';
import { uploadPickedFile, validateSizes } from './share';
import { Button, Dialog, DialogFooter, ErrorText, ProgressBar } from './ui';

type FileEntry = Extract<FolderPickEntry, { kind: 'file' }>;

interface Row {
  item: Manifest['items'][number];
  file: FileEntry;
  body: string;
  sha256: string;
  status: ImportStatus;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'review' }
  | { kind: 'running'; done: number; total: number; current: string }
  | { kind: 'done'; added: number; updated: number; failed: string[] };

/** 選到的資料夾是 Hills 匯出（根目錄有 hills-kb.json）。 */
export function isHillsExport(pick: FolderPick): boolean {
  return pick.entries.some((e) => e.kind === 'file' && e.path === MANIFEST);
}

export function KbRestore({
  pick,
  data,
  me,
  onClose,
  onImported,
}: {
  pick: FolderPick;
  data: KbSnapshot;
  me: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const files = new Map(
    pick.entries.filter((e): e is FileEntry => e.kind === 'file').map((e) => [e.path, e]),
  );
  const [existing] = useState(() => importedBy(data.items, me, pick.root));
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [missingFiles, setMissingFiles] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);
  const started = useRef(false);

  // 讀 manifest 與每則的 Markdown，算雜湊並比對（只跑一次）
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const mf = files.get(MANIFEST)!;
        const m = parseManifest(new TextDecoder().decode(await readAll(mf.token, mf.size)));
        if (!m) throw new Error(t('kbRestore.badManifest'));
        const out: Row[] = [];
        let lost = 0;
        for (const it of m.items) {
          const f = files.get(it.path);
          if (!f || validateSizes([f.size]) !== null) {
            lost++;
            continue;
          }
          const bytes = await readAll(f.token, f.size);
          const body = stripFrontMatter(new TextDecoder().decode(bytes));
          const sha256 = await sha256Hex(bytes);
          out.push({
            item: it,
            file: f,
            body,
            sha256,
            status: statusOf(existing, it.path, sha256, it.title),
          });
        }
        setManifest(m);
        setRows(out);
        setMissingFiles(lost);
        setPhase({ kind: 'review' });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase({ kind: 'review' });
      }
    })();
  });

  const chosen = rows.filter((r) => r.status !== 'same');
  const added = rows.filter((r) => r.status === 'new').length;
  const updated = rows.filter((r) => r.status === 'changed').length;
  const same = rows.length - chosen.length;

  const run = async () => {
    if (!manifest) return;
    cancel.current = false;
    setError(null);
    const failed: string[] = [];
    let nAdded = 0;
    let nUpdated = 0;
    try {
      const nodes = await api.storageNodes();
      // 分類與主題：依 manifest 名稱找既有的（最終項目），沒有才建立
      let snap = await api.kb();
      const catIds = new Map<string, string>();
      for (const c of manifest.categories) {
        const found = snap.categories.find((x) => x.resolved === x.id && x.name === c.name);
        catIds.set(c.id, found?.id ?? (await api.kbCreateCategory(c.name)));
      }
      snap = await api.kb();
      const topicIds = new Map<string, string>();
      for (const tp of manifest.topics) {
        const cat = catIds.get(tp.categoryId);
        if (!cat) continue;
        const found = snap.topics.find(
          (x) => x.resolved === x.id && x.categoryId === cat && x.name === tp.name,
        );
        topicIds.set(tp.id, found?.id ?? (await api.kbCreateTopic(cat, tp.name)));
      }
      // 舊 key → 新 key（沒有變更的沿用既有的）
      const keys = new Map<string, string>();
      for (const r of rows) {
        const prev = existing.get(r.item.path);
        if (prev) keys.set(r.item.key, prev.key);
      }
      const saved: {
        row: Row;
        key: string;
        prev: KbItem | undefined;
        input: Parameters<typeof api.kbSave>[0];
      }[] = [];
      for (let i = 0; i < chosen.length; i++) {
        if (cancel.current) break;
        const r = chosen[i]!;
        setPhase({ kind: 'running', done: i, total: chosen.length, current: r.item.title });
        try {
          const topicId = topicIds.get(r.item.topicId);
          if (!topicId) throw new Error(t('kbRestore.noTopic'));
          const att = r.item.attachments[0];
          const af = att && files.get(att.path);
          const attachment = af
            ? await uploadPickedFile(af.token, att.name, af.size, af.mtime, nodes)
            : undefined;
          const prev = existing.get(r.item.path);
          const origin = t('kbRestore.origin', {
            name: r.item.authorName || '—',
            date: formatDate(r.item.createdAt),
          });
          const input = {
            key: prev?.key ?? null,
            title: r.item.title,
            body: `${r.body.trim()}\n\n> ${origin}`,
            format: 'markdown' as const,
            spec: null,
            tags: r.item.tags.slice(0, 10),
            topicId,
            refs: prev?.refs ?? [],
            source: {
              kind: 'import' as const,
              root: pick.root,
              path: r.item.path,
              sha256: r.sha256,
              ...(attachment ? { attachment } : {}),
            },
          };
          const key = await api.kbSave(input);
          keys.set(r.item.key, key);
          saved.push({ row: r, key, prev, input });
          if (prev) nUpdated++;
          else nAdded++;
        } catch (e) {
          failed.push(`${r.item.title}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // 重建知識之間的引用
      for (const s of saved) {
        const refs = remapRefs(s.row.item.refs, keys).slice(0, 20);
        if (refs.length === 0) continue;
        try {
          await api.kbSave({ ...s.input, key: s.key, refs });
        } catch (e) {
          failed.push(`${s.row.item.title}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPhase({ kind: 'done', added: nAdded, updated: nUpdated, failed });
    onImported();
  };

  return (
    <Dialog
      title={t('kbRestore.title', { name: pick.root })}
      width="md"
      onClose={phase.kind === 'running' ? () => undefined : onClose}
      footer={
        phase.kind === 'review' ? (
          chosen.length === 0 ? (
            <DialogFooter>
              <Button onClick={onClose}>{t('common.close')}</Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void run()}>{t('kbImport.submit')}</Button>
            </DialogFooter>
          )
        ) : phase.kind === 'running' ? (
          <DialogFooter>
            <Button variant="secondary" onClick={() => (cancel.current = true)}>
              {t('kbImport.stop')}
            </Button>
          </DialogFooter>
        ) : phase.kind === 'done' ? (
          <DialogFooter>
            <Button onClick={onClose}>{t('kbImport.done')}</Button>
          </DialogFooter>
        ) : undefined
      }
    >
      {phase.kind === 'checking' && (
        <div className="flex flex-col gap-2 py-4">
          <ProgressBar value={50} label={t('kbImport.checking')} />
          <p className="text-sm text-muted">{t('kbRestore.checking')}</p>
        </div>
      )}
      {phase.kind === 'review' && manifest && (
        <div className="flex flex-col gap-3 text-sm">
          {chosen.length === 0 ? (
            <p className="font-semibold">{t('kbImport.nothing')}</p>
          ) : (
            <p className="text-base font-bold">
              {added && updated
                ? t('kbImport.will', { added, updated })
                : added
                  ? t('kbImport.willAdd', { n: added })
                  : t('kbImport.willUpdate', { n: updated })}
            </p>
          )}
          <p>
            {t('kbRestore.from', {
              org: manifest.org || '—',
              date: formatDate(manifest.exportedAt),
            })}
          </p>
          <p>
            {t('kbRestore.where', {
              n: manifest.categories.length,
              names: manifest.categories.map((c) => c.name).join('、'),
            })}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted">
            {same > 0 && <li>{t('kbImport.sameN', { n: same })}</li>}
            {missingFiles > 0 && <li>{t('kbRestore.missingFiles', { n: missingFiles })}</li>}
            <li>{t('kbRestore.author')}</li>
          </ul>
          {chosen.length > 0 && (
            <p role="note" className="rounded-control bg-bg px-3 py-2 text-xs">
              {t('kbImport.public')}
            </p>
          )}
        </div>
      )}
      {phase.kind === 'running' && (
        <div className="flex flex-col gap-2 py-4">
          <ProgressBar
            value={Math.round((phase.done / Math.max(1, phase.total)) * 100)}
            label={t('kbImport.running')}
          />
          <p className="text-sm text-muted">
            {t('kbImport.runningN', { done: phase.done, total: phase.total, name: phase.current })}
          </p>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">
            {t('kbImport.summary', { added: phase.added, updated: phase.updated })}
          </p>
          {phase.failed.length > 0 && (
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-muted">
              {phase.failed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}
