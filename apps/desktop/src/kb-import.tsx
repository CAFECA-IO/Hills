/**
 * 知識庫「匯入資料夾」（ui-spec「知識庫 › 匯入資料夾」v0.52、technical-design §16.22，D71）。
 * 比對 → 選擇 → 逐檔轉換、上傳附件、存成知識 → 摘要。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FolderPick, type KbItem, type KbSnapshot } from './api';
import { t } from './i18n';
import {
  htmlToMarkdown,
  importedBy,
  markdownTitle,
  missingFrom,
  pickImportable,
  sha256Hex,
  statusOf,
  titleFor,
  truncateBody,
  type ImportFile,
  type ImportStatus,
} from './kb-import-utils';
import { formatBytes, uploadPickedFile, validateSizes } from './share';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  ErrorText,
  Field,
  ProgressBar,
  TextInput,
} from './ui';

interface Prepared extends ImportFile {
  sha256: string;
  status: ImportStatus;
  /** md / html 的內文與標題（pdf 為 null） */
  body: string | null;
  title: string;
  truncated: boolean;
  tooLarge: boolean;
}

type Phase =
  | { kind: 'checking'; done: number }
  | { kind: 'review' }
  | { kind: 'running'; done: number; current: string }
  | { kind: 'done' };

interface Outcome {
  added: number;
  updated: number;
  failed: { path: string; error: string }[];
}

/** 讀出整個檔案（`read_stripe` 每次 8 MB）。 */
async function readAll(token: string, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  const step = 8 * 1024 * 1024;
  for (let o = 0; o < size; o += step) {
    const part = await api.readStripe(token, o, Math.min(step, size - o));
    out.set(part, o);
  }
  return out;
}

async function prepare(
  f: ImportFile,
  existing: Map<string, KbItem>,
  note: string,
): Promise<Prepared> {
  const tooLarge = validateSizes([f.size]) !== null;
  if (tooLarge)
    return {
      ...f,
      sha256: '',
      status: 'new',
      body: null,
      title: f.path,
      truncated: false,
      tooLarge,
    };
  const bytes = await readAll(f.token, f.size);
  const sha256 = await sha256Hex(bytes);
  let body: string | null = null;
  let found: string | null = null;
  if (f.kind === 'html') {
    const r = htmlToMarkdown(new TextDecoder().decode(bytes));
    body = r.markdown;
    found = r.title;
  } else if (f.kind === 'md') {
    body = new TextDecoder().decode(bytes);
    found = markdownTitle(body);
  }
  const name = f.path.split('/').pop() ?? f.path;
  const cut = truncateBody(body ?? t('kbImport.pdfBody', { name }), note);
  return {
    ...f,
    sha256,
    status: statusOf(existing, f.path, sha256),
    body: cut.body,
    title: titleFor(f.path, found),
    truncated: cut.truncated,
    tooLarge: false,
  };
}

const STATUS_TONE = { new: 'primary', changed: 'solid', same: 'neutral' } as const;

export function KbImport({
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
  const { files, skipped, overLimit } = useMemo(() => pickImportable(pick.entries), [pick]);
  // 打開時的快照：匯入後知識庫重新載入，不重新比對（摘要保持不變）
  const [existing] = useState(() => importedBy(data.items, me, pick.root));
  const missing = useMemo(() => missingFrom(existing, files), [existing, files]);
  const [phase, setPhase] = useState<Phase>({ kind: 'checking', done: 0 });
  const [prepared, setPrepared] = useState<Prepared[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState(pick.root);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);

  // 讀檔、計算雜湊與轉換（只在這台電腦）
  useEffect(() => {
    let live = true;
    void (async () => {
      const out: Prepared[] = [];
      const note = t('kbImport.truncatedNote');
      for (const f of files) {
        if (!live) return;
        try {
          out.push(await prepare(f, existing, note));
        } catch (e) {
          out.push({
            ...f,
            sha256: '',
            status: 'new',
            body: null,
            title: f.path,
            truncated: false,
            tooLarge: true,
          });
          setError(String(e));
        }
        setPhase({ kind: 'checking', done: out.length });
      }
      if (!live) return;
      setPrepared(out);
      setSelected(
        new Set(out.filter((p) => !p.tooLarge && p.status !== 'same').map((p) => p.path)),
      );
      setPhase({ kind: 'review' });
    })();
    return () => {
      live = false;
    };
  }, [files, existing]);

  const groups = useMemo(() => {
    const m = new Map<string, Prepared[]>();
    for (const p of prepared) m.set(p.topic, [...(m.get(p.topic) ?? []), p]);
    return [...m.entries()];
  }, [prepared]);

  const run = async (targets: Prepared[]) => {
    cancel.current = false;
    setError(null);
    const result: Outcome = { added: 0, updated: 0, failed: [] };
    try {
      const nodes = await api.storageNodes();
      // 分類與主題：依名稱沿用既有的（合併後的最終項目），沒有才建立
      const catName = category.trim() || pick.root;
      let snap = await api.kb();
      let cat = snap.categories.find((c) => c.resolved === c.id && c.name === catName)?.id;
      if (!cat) cat = await api.kbCreateCategory(catName);
      const topicIds = new Map<string, string>();
      for (const name of new Set(targets.map((p) => p.topic))) {
        snap = await api.kb();
        const found = snap.topics.find(
          (x) => x.resolved === x.id && x.categoryId === cat && x.name === name,
        );
        topicIds.set(name, found?.id ?? (await api.kbCreateTopic(cat, name)));
      }
      for (let i = 0; i < targets.length; i++) {
        if (cancel.current) break;
        const p = targets[i]!;
        setPhase({ kind: 'running', done: i, current: p.path });
        try {
          const name = p.path.split('/').pop() ?? p.path;
          const attach = p.kind !== 'md' || p.truncated;
          const attachment = attach
            ? await uploadPickedFile(p.token, name, p.size, p.mtime, nodes)
            : undefined;
          const prev = existing.get(p.path);
          await api.kbSave({
            key: prev?.key ?? null,
            title: p.title,
            body: p.body ?? '',
            format: 'markdown',
            spec: null,
            tags: prev?.tags ?? [],
            topicId: topicIds.get(p.topic)!,
            refs: prev?.refs ?? [],
            source: {
              kind: 'import',
              root: pick.root,
              path: p.path,
              sha256: p.sha256,
              ...(attachment ? { attachment } : {}),
            },
          });
          if (prev) result.updated++;
          else result.added++;
        } catch (e) {
          result.failed.push({ path: p.path, error: String(e) });
        }
      }
    } catch (e) {
      setError(String(e));
    }
    setOutcome(result);
    setPhase({ kind: 'done' });
    onImported();
  };

  const chosen = prepared.filter((p) => selected.has(p.path));
  const toggle = (path: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(path);
      else n.delete(path);
      return n;
    });

  return (
    <Dialog
      title={t('kbImport.title', { name: pick.root })}
      width="xl"
      onClose={phase.kind === 'running' ? () => undefined : onClose}
      footer={
        phase.kind === 'review' ? (
          <DialogFooter start={<span className="text-xs text-muted">{t('kbImport.public')}</span>}>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={chosen.length === 0} onClick={() => void run(chosen)}>
              {t('kbImport.submit', { n: chosen.length })}
            </Button>
          </DialogFooter>
        ) : phase.kind === 'running' ? (
          <DialogFooter>
            <Button variant="secondary" onClick={() => (cancel.current = true)}>
              {t('kbImport.stop')}
            </Button>
          </DialogFooter>
        ) : phase.kind === 'done' ? (
          <DialogFooter>
            {outcome && outcome.failed.length > 0 && (
              <Button
                variant="secondary"
                onClick={() =>
                  void run(prepared.filter((p) => outcome.failed.some((f) => f.path === p.path)))
                }
              >
                {t('kbImport.retry')}
              </Button>
            )}
            <Button onClick={onClose}>{t('kbImport.done')}</Button>
          </DialogFooter>
        ) : undefined
      }
    >
      {phase.kind === 'checking' && (
        <div className="flex flex-col gap-2 py-6">
          <ProgressBar
            value={files.length ? Math.round((phase.done / files.length) * 100) : 100}
            label={t('kbImport.checking')}
          />
          <p className="text-sm text-muted">
            {t('kbImport.checkingN', { done: phase.done, total: files.length })}
          </p>
        </div>
      )}
      {phase.kind === 'review' && (
        <div className="flex flex-col gap-4">
          <Field label={t('kbImport.category')} hint={t('kbImport.categoryHint')}>
            <TextInput value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          {prepared.length === 0 ? (
            <p className="text-sm text-muted">{t('kbImport.none')}</p>
          ) : (
            <div className="flex max-h-[50vh] flex-col gap-3 overflow-auto pr-1">
              {groups.map(([topic, list]) => (
                <section key={topic} className="flex flex-col gap-1">
                  <h3 className="text-xs font-bold text-muted">
                    {t('kbImport.topic', { name: topic, n: list.length })}
                  </h3>
                  <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
                    {list.map((p) => (
                      <li key={p.path} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                        <Checkbox
                          checked={selected.has(p.path)}
                          disabled={p.tooLarge}
                          onChange={(e) => toggle(p.path, e.target.checked)}
                          aria-label={p.path}
                        />
                        <span className="min-w-0 flex-1 truncate" title={p.path}>
                          {p.path}
                        </span>
                        <span className="shrink-0 text-xs text-muted">{formatBytes(p.size)}</span>
                        {p.tooLarge ? (
                          <Badge tone="alert">{t('kbImport.status.tooLarge')}</Badge>
                        ) : (
                          <>
                            {p.truncated && <Badge>{t('kbImport.status.truncated')}</Badge>}
                            <Badge tone={STATUS_TONE[p.status]}>
                              {t(`kbImport.status.${p.status}`)}
                            </Badge>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">
            {t('kbImport.skipped', { n: skipped })}
            {overLimit > 0 && ` · ${t('kbImport.overLimit', { n: overLimit })}`}
            {missing.length > 0 && ` · ${t('kbImport.missing', { n: missing.length })}`}
          </p>
        </div>
      )}
      {phase.kind === 'running' && (
        <div className="flex flex-col gap-2 py-6">
          <ProgressBar
            value={Math.round((phase.done / Math.max(1, chosen.length)) * 100)}
            label={t('kbImport.running')}
          />
          <p className="truncate text-sm text-muted">
            {t('kbImport.runningN', {
              done: phase.done + 1,
              total: chosen.length,
              name: phase.current,
            })}
          </p>
        </div>
      )}
      {phase.kind === 'done' && outcome && (
        <div className="flex flex-col gap-2 py-2 text-sm">
          <p className="font-semibold">
            {t('kbImport.summary', {
              added: outcome.added,
              updated: outcome.updated,
              same: prepared.filter((p) => p.status === 'same' && !selected.has(p.path)).length,
            })}
          </p>
          {outcome.failed.length > 0 && (
            <ul className="flex flex-col gap-1">
              {outcome.failed.map((f) => (
                <li key={f.path} className="text-warning">
                  {t('kbImport.failed', { path: f.path, error: f.error })}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <p className="text-xs text-muted">{t('kbImport.missing', { n: missing.length })}</p>
          )}
        </div>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}
