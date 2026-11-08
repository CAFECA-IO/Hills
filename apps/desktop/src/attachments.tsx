/** 檔案分享的畫面（ui-spec「檔案分享」，D40 視覺語言）：附件選單、資料夾摘要、上傳佇列、附件卡、下載。 */
import { useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, type FolderPick, type MemberView } from './api';
import { formatTime, t, type MessageKey } from './i18n';
import {
  cancel,
  decodeToMemory,
  downloadFile,
  errorKind,
  formatBytes,
  pause,
  parseFolderManifest,
  resume,
  retry,
  startFiles,
  startFolder,
  uploads,
  validateSizes,
  type Attachment,
  type DownloadResult,
  type UploadJob,
} from './share';
import {
  Button,
  Checkbox,
  ErrorText,
  IconButton,
  Menu,
  MenuItem,
  Popover,
  ProgressBar,
  useAction,
} from './ui';

const v = (name: string) => `var(--hills-${name})`;

function FileIcon({ folder = false }: { folder?: boolean }) {
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" aria-hidden className="shrink-0">
      <rect
        width={36}
        height={36}
        rx={10}
        fill={v(folder ? 'st-away' : 'primary-soft')}
        opacity={folder ? 0.25 : 1}
      />
      {folder ? (
        <path
          d="M9 13h7l2 2h9v10H9z"
          fill="none"
          stroke={v('st-away-text')}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M12 9h8l5 5v13H12zM20 9v5h5"
          fill="none"
          stroke={v('primary')}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

// ── 附件選單與資料夾摘要 ─────────────────────────────────────

export function AttachMenu({ conv }: { conv: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [folder, setFolder] = useState<FolderPick | null>(null);
  const { busy, error, run, setError } = useAction();
  const pickFiles = async () => {
    setOpen(false);
    const files = await run(api.pickFiles);
    if (!files || files.length === 0) return;
    if (validateSizes(files.map((f) => f.size))) {
      setError(t('files.tooLarge'));
      return;
    }
    startFiles(conv, files);
  };
  const pickFolder = async () => {
    setOpen(false);
    const f = await run(api.pickFolder);
    if (f) setFolder(f);
  };
  return (
    <div className="relative">
      <IconButton
        ref={btn}
        variant="secondary"
        label={t('files.attach')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width={18} height={18} viewBox="0 0 20 20" aria-hidden>
          <path
            d="M14.5 9.5l-5.6 5.6a3.2 3.2 0 0 1-4.5-4.5l6.2-6.2a2.2 2.2 0 0 1 3.1 3.1l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.4-5.4"
            stroke="currentColor"
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>
      {open && (
        <Menu
          label={t('files.attach')}
          onClose={() => setOpen(false)}
          anchorRef={btn}
          className="absolute bottom-full left-0 mb-2"
        >
          <MenuItem onSelect={() => void pickFiles()}>{t('files.pickFiles')}</MenuItem>
          <MenuItem onSelect={() => void pickFolder()}>{t('files.pickFolder')}</MenuItem>
        </Menu>
      )}
      {folder && (
        <FolderSummary
          pick={folder}
          onCancel={() => setFolder(null)}
          onConfirm={() => {
            if (validateSizes(folder.entries.map((e) => (e.kind === 'file' ? e.size : 0)))) {
              setError(t('files.tooLarge'));
            } else {
              startFolder(conv, folder);
            }
            setFolder(null);
          }}
        />
      )}
      {error && (
        <div className="absolute bottom-full left-0 mb-2 w-72">
          <ErrorText message={error} />
        </div>
      )}
    </div>
  );
}

const SKIP_REASON: Record<string, MessageKey> = {
  symlink: 'files.skip.symlink',
  system: 'files.skip.system',
  unreadable: 'files.skip.unreadable',
};

function FolderSummary({
  pick,
  onConfirm,
  onCancel,
}: {
  pick: FolderPick;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Popover
      label={t('files.folder.title', { name: pick.root })}
      onClose={onCancel}
      closeOnOutside={false}
      className="absolute bottom-full left-0 mb-2 flex w-96 flex-col gap-3 p-4"
    >
      <div className="flex items-center gap-3">
        <FileIcon folder />
        <div className="min-w-0">
          <p className="truncate font-bold">{pick.root}</p>
          <p className="text-sm text-muted">
            {t('files.folder.summary', {
              count: pick.fileCount,
              size: formatBytes(pick.totalSize),
            })}
          </p>
        </div>
      </div>
      {pick.skipped.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">
            {t('files.folder.skipped', { count: pick.skipped.length })}
          </p>
          <ul className="max-h-28 overflow-auto text-xs text-muted">
            {pick.skipped.map((s) => (
              <li key={s.path} className="truncate">
                {s.path} · {t(SKIP_REASON[s.reason] ?? 'files.skip.unreadable')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <Button disabled={pick.fileCount === 0} onClick={onConfirm}>
          {t('files.folder.upload')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Popover>
  );
}

// ── 上傳佇列 ────────────────────────────────────────────────

const JOB_ERRORS: Record<string, MessageKey> = {
  noNodes: 'files.error.noNodes',
  missingFile: 'files.error.missingFile',
  tooManyFiles: 'files.error.tooManyFiles',
  readFailed: 'files.error.readFailed',
};

export function useUploads(): UploadJob[] {
  return useSyncExternalStore(uploads.subscribe, uploads.get);
}

function eta(job: UploadJob): string | null {
  const elapsed = Date.now() - job.startedAt;
  if (job.doneBytes <= 0 || elapsed < 3000) return null;
  const rest = ((job.totalBytes - job.doneBytes) / job.doneBytes) * elapsed;
  const min = Math.max(1, Math.round(rest / 60000));
  return t('files.eta', { min });
}

export function UploadQueue({ conv }: { conv: string }) {
  const list = useUploads().filter((j) => j.conv === conv);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-3 pt-3">
      {list.map((j) => {
        const pct = j.totalBytes > 0 ? j.doneBytes / j.totalBytes : 0;
        const err = j.error ? (JOB_ERRORS[j.error] ? t(JOB_ERRORS[j.error]) : j.error) : null;
        return (
          <div key={j.id} className="flex flex-col gap-2 rounded-card bg-bg p-3">
            <div className="flex items-center gap-3">
              <FileIcon folder={j.kind === 'folder'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">
                  {j.title}
                  <span className="font-normal text-muted">
                    {' · '}
                    {j.kind === 'folder'
                      ? t('files.folder.summary', {
                          count: j.items.length,
                          size: formatBytes(j.totalBytes),
                        })
                      : formatBytes(j.totalBytes)}
                  </span>
                </p>
                <p className="truncate text-xs text-muted">
                  {j.status === 'failed'
                    ? err
                    : j.status === 'paused'
                      ? t('files.paused')
                      : `${t('files.uploading')}${j.current ? ` · ${t('files.current', { name: j.current })}` : ''}${eta(j) ? ` · ${eta(j)}` : ''}`}
                </p>
              </div>
              <span className="text-sm font-bold">{Math.round(pct * 100)}%</span>
            </div>
            <ProgressBar value={pct} label={t('files.progress', { name: j.title })} />
            <div className="flex gap-2">
              {j.status === 'failed' ? (
                <Button variant="soft" size="sm" onClick={() => retry(j.id)}>
                  {t('common.retry')}
                </Button>
              ) : j.status === 'paused' ? (
                <Button variant="soft" size="sm" onClick={() => resume(j.id)}>
                  {t('files.resume')}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => pause(j.id, true)}>
                  {t('files.pause')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => cancel(j.id)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 重新開啟 App 後的提示：「有未完成的上傳，繼續上傳？」 */
export function PendingUploads({
  count,
  onResume,
  onDiscard,
}: {
  count: number;
  onResume: () => void;
  onDiscard: () => void;
}) {
  if (count === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-card bg-primary-soft px-4 py-3 text-sm"
    >
      <span className="font-semibold text-primary">{t('files.pending', { count })}</span>
      <Button variant="primary" size="sm" onClick={onResume}>
        {t('files.resume')}
      </Button>
      <Button variant="secondary" size="sm" onClick={onDiscard}>
        {t('files.discard')}
      </Button>
    </div>
  );
}

// ── 附件卡與下載 ────────────────────────────────────────────

type DownloadState =
  | { phase: 'idle' }
  | { phase: 'running'; done: number; total: number; current: string }
  | { phase: 'done'; token: string; result: DownloadResult; folder: boolean }
  | { phase: 'error'; message: string };

export function AttachmentCard({
  a,
  author,
  createdAt,
}: {
  a: Attachment;
  author: MemberView | undefined;
  createdAt: number;
}) {
  const [state, setState] = useState<DownloadState>({ phase: 'idle' });
  const [choosing, setChoosing] = useState<{ token: string; entries: FolderFile[] } | null>(null);
  const folder = a.type === 'folder';
  const name = folder ? a.name : a.manifest.name;
  const size = folder ? a.totalSize : a.manifest.size;
  const fail = (e: unknown) => {
    const kind = errorKind(e);
    setState({
      phase: 'error',
      message:
        kind === 'unrecoverable'
          ? t('files.unrecoverable')
          : kind === 'decrypt'
            ? t('files.decryptFailed')
            : errorMessage(e),
    });
  };

  const downloadSingle = async () => {
    if (a.type !== 'file') return;
    const token = await api.saveTargetFile(a.manifest.name).catch(fail);
    if (!token) return;
    setState({ phase: 'running', done: 0, total: a.manifest.size, current: a.manifest.name });
    try {
      const final = await downloadFile(a.manifest, a.fileKey, token, '', (done) =>
        setState({ phase: 'running', done, total: a.manifest.size, current: a.manifest.name }),
      );
      setState({
        phase: 'done',
        token,
        folder: false,
        result: {
          renamed: final !== a.manifest.name ? [{ from: a.manifest.name, to: final }] : [],
          last: { path: '', name: final },
        },
      });
    } catch (e) {
      fail(e);
    }
  };

  const loadFolder = async (): Promise<FolderFile[] | null> => {
    if (a.type !== 'folder') return null;
    const bytes = await decodeToMemory(a.manifestRef, a.manifestKey);
    const m = parseFolderManifest(bytes);
    return m.entries
      .filter((e) => e.kind === 'file')
      .map((e) => ({ path: `${a.name}/${e.path}`, manifest: e.manifest, fileKey: e.fileKey }));
  };

  const downloadFolder = async (only?: FolderFile[], token0?: string) => {
    try {
      const target = token0 ?? (await api.saveTargetFolder())?.token;
      if (!target) return;
      setState({ phase: 'running', done: 0, total: size, current: '' });
      const files = only ?? (await loadFolder()) ?? [];
      const total = files.reduce((n, f) => n + f.manifest.size, 0);
      let base = 0;
      const renamed: DownloadResult['renamed'] = [];
      let last: DownloadResult['last'] = null;
      for (const f of files) {
        setState({ phase: 'running', done: base, total, current: f.path });
        const final = await downloadFile(f.manifest, f.fileKey, target, f.path, (done) =>
          setState({ phase: 'running', done: base + done, total, current: f.path }),
        );
        const orig = f.path.split('/').pop() ?? '';
        if (final !== orig) renamed.push({ from: f.path, to: final });
        last = { path: f.path, name: final };
        base += f.manifest.size;
      }
      setState({ phase: 'done', token: target, folder: true, result: { renamed, last } });
    } catch (e) {
      fail(e);
    }
  };

  const chooseFiles = async () => {
    try {
      const target = await api.saveTargetFolder();
      if (!target) return;
      setState({ phase: 'running', done: 0, total: 0, current: '' });
      const entries = (await loadFolder()) ?? [];
      setState({ phase: 'idle' });
      setChoosing({ token: target.token, entries });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="mt-1 flex max-w-md flex-col gap-2 rounded-card border border-line bg-surface p-3">
      <div className="flex items-center gap-3">
        <FileIcon folder={folder} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{name}</p>
          <p className="truncate text-xs text-muted">
            {folder
              ? t('files.folder.summary', { count: a.fileCount, size: formatBytes(size) })
              : formatBytes(size)}
            {author && ` · ${author.name}`} · {formatTime(createdAt)}
          </p>
        </div>
      </div>
      {state.phase === 'running' && (
        <div className="flex flex-col gap-1">
          <ProgressBar
            value={state.total ? state.done / state.total : 0}
            label={t('files.downloading')}
          />
          <p className="truncate text-xs text-muted">
            {t('files.downloading')}
            {state.current && ` · ${state.current}`}
          </p>
        </div>
      )}
      {state.phase === 'done' && <DoneSummary state={state} />}
      {state.phase === 'error' && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
      {choosing && (
        <ChooseFiles
          entries={choosing.entries}
          onCancel={() => setChoosing(null)}
          onConfirm={(picked) => {
            const tok = choosing.token;
            setChoosing(null);
            void downloadFolder(picked, tok);
          }}
        />
      )}
      {state.phase !== 'running' && state.phase !== 'done' && !choosing && (
        <div className="flex flex-wrap gap-2">
          {folder ? (
            <>
              <Button variant="soft" size="sm" onClick={() => void downloadFolder()}>
                {t('files.downloadAll')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void chooseFiles()}>
                {t('files.chooseFiles')}
              </Button>
            </>
          ) : (
            <Button variant="soft" size="sm" onClick={() => void downloadSingle()}>
              {state.phase === 'error' ? t('common.retry') : t('files.download')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface FolderFile {
  path: string;
  manifest: Extract<Attachment, { type: 'file' }>['manifest'];
  fileKey: string;
}

function DoneSummary({ state }: { state: Extract<DownloadState, { phase: 'done' }> }) {
  const { error, attempt } = useAction();
  const last = state.result.last;
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="text-sm font-semibold text-st-online-text">
        {t('files.done')}
      </p>
      {state.result.renamed.length > 0 && (
        <div className="text-xs text-muted">
          <p className="font-semibold">{t('files.renamed')}</p>
          <ul>
            {state.result.renamed.map((r) => (
              <li key={r.from} className="truncate">
                {r.from} → {r.to}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!state.folder && last && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void attempt(() => api.showDownload(state.token, last.path, last.name, true))
            }
          >
            {t('files.open')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void attempt(() =>
              state.folder
                ? api.showDownload(state.token, '', '', false)
                : api.showDownload(state.token, last?.path ?? '', last?.name ?? '', false),
            )
          }
        >
          {t('files.reveal')}
        </Button>
      </div>
      <ErrorText message={error} />
    </div>
  );
}

function ChooseFiles({
  entries,
  onConfirm,
  onCancel,
}: {
  entries: FolderFile[];
  onConfirm: (picked: FolderFile[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const sorted = [...entries].sort((x, y) => x.path.localeCompare(y.path));
  return (
    <div className="flex flex-col gap-2">
      <ul className="max-h-60 overflow-auto rounded-control border border-line p-2 text-sm">
        {sorted.map((e) => {
          const depth = e.path.split('/').length - 2;
          return (
            <li key={e.path} style={{ paddingLeft: `${depth * 16}px` }}>
              <label className="flex items-center gap-2 py-0.5">
                <Checkbox
                  checked={picked.has(e.path)}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(e.path)) n.delete(e.path);
                      else n.add(e.path);
                      return n;
                    })
                  }
                />
                <span className="truncate">{e.path.split('/').slice(1).join('/')}</span>
                <span className="ml-auto shrink-0 text-xs text-muted">
                  {formatBytes(e.manifest.size)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <Button
          disabled={picked.size === 0}
          onClick={() => onConfirm(sorted.filter((e) => picked.has(e.path)))}
        >
          {t('files.downloadPicked', { count: picked.size })}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
