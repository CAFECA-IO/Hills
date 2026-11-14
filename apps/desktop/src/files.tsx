/**
 * 檔案（ui-spec「檔案」v0.44，D64；technical-design §16.19）：本人看得到的所有附件、出處與前往出處。
 */
import { useState } from 'react';
import { AttachmentCard } from './attachments';
import { api, type FileEntry, type FileSource, type MemberView } from './api';
import { convTitle } from './chat-utils';
import {
  DEFAULT_FILTER,
  FILE_TYPES,
  SOURCE_KINDS,
  badgeOf,
  expiryOf,
  filterFiles,
  isFiltered,
  scopeCounts,
  type FileFilter,
  type FileScope,
} from './files-utils';
import { useLoad } from './hooks';
import { formatDate, formatTime, t } from './i18n';
import { PageHead } from './layout';
import { navigate } from './nav';
import { formatBytes, parseAttachments } from './share';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorText,
  IconButton,
  LinkButton,
  ListButton,
  Select,
  TextInput,
  ToggleChip,
  useAction,
} from './ui';

interface Props {
  members: MemberView[];
  /** 從對話「這段對話的檔案」進來：預先篩選該對話 */
  conv?: string | null;
  /** 從附件卡「在檔案中顯示」進來：選取這個檔案 */
  fileKey?: string | null;
}

const SCOPES: FileScope[] = ['all', 'mine', 'others', 'downloaded'];

/** 出處圖示（design-system §9：自繪 SVG，不用表情符號）。 */
export function SourceIcon({ kind }: { kind: FileSource['kind'] }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'message' ? (
        <path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 16 14H9l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5z" />
      ) : kind === 'taskReport' ? (
        <>
          <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" />
          <path d="M7 10.2l2.2 2.2L13.5 8" />
        </>
      ) : (
        <path d="M10 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z" />
      )}
    </svg>
  );
}

export function Files({ members, conv = null, fileKey = null }: Props) {
  const files = useLoad(api.listFiles, ['message', 'doc', 'convs', 'org']);
  const convs = useLoad(api.conversations, ['convs']);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.name ?? '?') : t('home.unassigned');
  const convName = (id: string) => {
    const c = convs.data?.find((x) => x.id === id);
    return c ? convTitle(c, me, (x) => nameOf(x)) : t('fpage.src.chatUnknown');
  };
  const [filter, setFilter] = useState<FileFilter>({ ...DEFAULT_FILTER, conv });
  const [selected, setSelected] = useState<string | null>(fileKey);
  const [now] = useState(() => Date.now());
  const all = files.data ?? [];
  const list = filterFiles(all, filter, me);
  const counts = scopeCounts(all, me, filter);
  const filtered = isFiltered(filter);
  const clearAll = () => setFilter({ ...DEFAULT_FILTER, scope: filter.scope });
  const current = all.find((x) => x.key === selected) ?? null;
  const sharers = [...new Set(all.map((x) => x.sharedBy).filter((x): x is string => Boolean(x)))];
  const set = (p: Partial<FileFilter>) => setFilter((f) => ({ ...f, ...p }));
  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const srcLine = (s: FileSource) =>
    s.kind === 'message'
      ? { kind: s.kind, title: convName(s.convId), sub: s.excerpt || t('fpage.src.noText') }
      : s.kind === 'taskReport'
        ? {
            kind: s.kind,
            title: t('fpage.src.task', { title: s.title }),
            sub: t('fpage.src.report'),
          }
        : { kind: s.kind, title: t('fpage.src.kb', { title: s.title }), sub: t('fpage.src.kbSub') };

  return (
    <div
      className={`grid h-full min-h-0 gap-3 wide:gap-4 ${
        current
          ? 'grid-cols-[208px_minmax(0,1fr)_300px] wide:grid-cols-[240px_minmax(0,1fr)_340px]'
          : 'grid-cols-[208px_minmax(0,1fr)] wide:grid-cols-[240px_minmax(0,1fr)]'
      }`}
    >
      <PageHead title={t('nav.files')} />
      <Card className="scroll-panel flex min-h-0 flex-col gap-4">
        <nav aria-label={t('fpage.scope')} className="flex flex-col gap-0.5">
          {SCOPES.map((s) => (
            <ListButton key={s} selected={filter.scope === s} onClick={() => set({ scope: s })}>
              <span className="flex-1">{t(`fpage.scope.${s}`)}</span>
              <span className="text-xs text-muted">{counts[s]}</span>
            </ListButton>
          ))}
        </nav>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-bold text-muted">{t('fpage.source')}</legend>
          {SOURCE_KINDS.map((k) => (
            <Checkbox
              key={k}
              label={
                <span className="flex items-center gap-1.5">
                  <SourceIcon kind={k} />
                  {t(`fpage.source.${k}`)}
                </span>
              }
              checked={filter.sources.length === 0 || filter.sources.includes(k)}
              onChange={() =>
                set({
                  sources:
                    filter.sources.length === 0
                      ? SOURCE_KINDS.filter((x) => x !== k)
                      : toggle(filter.sources, k).length === SOURCE_KINDS.length
                        ? []
                        : toggle(filter.sources, k),
                })
              }
            />
          ))}
          {filter.conv && (
            <span className="ml-6 flex items-center gap-1 rounded-control bg-primary-soft py-0.5 pr-0.5 pl-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-semibold text-primary">
                {t('fpage.onlyConv', { name: convName(filter.conv) })}
              </span>
              <IconButton
                size="sm"
                label={t('fpage.clearConv')}
                onClick={() => set({ conv: null })}
              >
                ×
              </IconButton>
            </span>
          )}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-muted">{t('fpage.type')}</span>
          <div role="group" aria-label={t('fpage.type')} className="flex flex-wrap gap-1.5">
            {FILE_TYPES.map((ty) => (
              <ToggleChip
                key={ty}
                checked={filter.types.includes(ty)}
                onChange={() => set({ types: toggle(filter.types, ty) })}
              >
                {t(`fpage.type.${ty}`)}
              </ToggleChip>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-xs font-bold text-muted">
          {t('fpage.sharer')}
          <Select
            size="sm"
            value={filter.sharer ?? ''}
            onChange={(e) => set({ sharer: e.target.value || null })}
          >
            <option value="">{t('fpage.sharer.any')}</option>
            {sharers.map((id) => (
              <option key={id} value={id}>
                {id === me ? t('fpage.me') : nameOf(id)}
              </option>
            ))}
          </Select>
        </label>
        <p className="mt-auto text-xs text-muted">{t('fpage.privacy')}</p>
      </Card>

      <Card className="flex min-h-0 flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2 px-2">
          <strong>
            {filter.conv
              ? t('fpage.convTitle', { name: convName(filter.conv) })
              : t(`fpage.scope.${filter.scope}`)}
          </strong>
          <span className="text-sm text-muted">{t('fpage.count', { n: list.length })}</span>
          {filter.conv && (
            <Chip selected onClick={() => set({ conv: null })} aria-label={t('fpage.clearConv')}>
              <SourceIcon kind="message" />
              {t('fpage.showAllConvs')} ×
            </Chip>
          )}
          <span className="flex-1" />
          <TextInput
            type="search"
            size="sm"
            className="w-64 wide:w-80"
            aria-label={t('fpage.search')}
            placeholder={t('fpage.search')}
            value={filter.query}
            onChange={(e) => set({ query: e.target.value })}
          />
        </div>
        <ErrorText message={files.error} />
        {list.length === 0 ? (
          <EmptyState
            art="generic"
            loading={files.data === null && !files.error}
            action={
              all.length > 0 && filtered ? (
                <Button variant="secondary" onClick={clearAll}>
                  {filter.conv ? t('fpage.seeAll') : t('fpage.clearFilters')}
                </Button>
              ) : undefined
            }
          >
            {all.length === 0
              ? t('fpage.empty')
              : filter.conv && list.length === 0 && !filter.query.trim()
                ? t('fpage.noneInConv', { name: convName(filter.conv) })
                : t('fpage.noMatch')}
          </EmptyState>
        ) : (
          <ul className="scroll-panel flex min-h-0 flex-1 flex-col divide-y divide-line">
            {list.map((x) => {
              const s = srcLine(x.sources[0]!);
              return (
                <li key={x.key} className="flex items-center gap-2 py-0.5">
                  <ListButton
                    selected={selected === x.key}
                    onClick={() => setSelected(x.key)}
                    className="min-w-0 flex-1 gap-3"
                  >
                    <FileBadge f={x} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold">{x.name}</span>
                      <span className="truncate text-xs text-muted">
                        {formatBytes(x.size)} ·{' '}
                        {x.sharedBy === me ? t('fpage.me') : nameOf(x.sharedBy)} ·{' '}
                        {formatTime(x.sharedAt)}
                      </span>
                    </span>
                    <span className="hidden min-w-0 flex-1 flex-col wide:flex">
                      <span className="flex min-w-0 items-center gap-1 text-xs font-semibold">
                        <SourceIcon kind={s.kind} />
                        <span className="truncate">{s.title}</span>
                      </span>
                      <span className="truncate text-xs text-muted">{s.sub}</span>
                    </span>
                    {x.sources.length > 1 && (
                      <Badge tone="primary">{t('fpage.more', { n: x.sources.length - 1 })}</Badge>
                    )}
                    <Status f={x} now={now} />
                  </ListButton>
                  <LinkButton
                    className="shrink-0 text-sm"
                    aria-label={t('fpage.goto.label', { name: x.name })}
                    onClick={() => goto(x.sources[0]!)}
                  >
                    {t('fpage.goto')}
                  </LinkButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {current && (
        <Detail f={current} me={me} nameOf={nameOf} members={members} srcLine={srcLine} />
      )}
    </div>
  );
}

function goto(s: FileSource) {
  if (s.kind === 'message')
    navigate({ page: 'chat', conv: s.convId, message: s.messageId, fromFiles: true });
  else if (s.kind === 'taskReport')
    navigate({ page: 'task', team: s.team, task: s.task, fromFiles: true });
  else navigate({ page: 'kb', item: s.kbKey, fromFiles: true });
}

function FileBadge({ f }: { f: FileEntry }) {
  return (
    <span
      aria-hidden
      className={`flex size-9 shrink-0 items-center justify-center rounded-control text-xs font-bold ${f.kind === 'folder' ? 'bg-primary-soft text-primary' : 'bg-bg text-muted'}`}
    >
      {badgeOf(f)}
    </span>
  );
}

function Status({ f, now }: { f: FileEntry; now: number }) {
  const exp = expiryOf(f.expiresAt, now);
  if (exp.kind === 'expired') return <Badge tone="alert">{t('fpage.status.expired')}</Badge>;
  if (f.downloaded) return <Badge tone="solid">{t('fpage.status.downloaded')}</Badge>;
  if (exp.kind === 'soon')
    return <Badge tone="alert">{t('fpage.status.soon', { n: exp.days })}</Badge>;
  return <Badge>{t('fpage.status.cloud')}</Badge>;
}

function Detail({
  f,
  me,
  nameOf,
  members,
  srcLine,
}: {
  f: FileEntry;
  me: string;
  nameOf: (id: string | null) => string;
  members: MemberView[];
  srcLine: (s: FileSource) => { kind: FileSource['kind']; title: string; sub: string };
}) {
  const { error, attempt } = useAction();
  const att = parseAttachments([f.attachment])[0];
  const first = f.sources[0]!;
  return (
    <Card className="scroll-panel flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <FileBadge f={f} />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate font-bold">{f.name}</h2>
          <span className="text-xs text-muted">
            {formatBytes(f.size)} · {t('fpage.keepUntil', { date: formatDate(f.expiresAt) })}
          </span>
        </div>
      </div>
      {f.downloaded ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void attempt(() => api.openDownloaded(f.key, false))}>
            {t('files.open')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void attempt(() => api.openDownloaded(f.key, true))}
          >
            {t('files.reveal')}
          </Button>
        </div>
      ) : (
        att && (
          <AttachmentCard
            a={att}
            author={members.find((m) => m.id === f.sharedBy)}
            createdAt={first.at}
            showInFiles={false}
          />
        )
      )}
      <ErrorText message={error} />
      <h3 className="text-sm font-bold">{t('fpage.sources', { n: f.sources.length })}</h3>
      <ol className="ml-1.5 flex flex-col gap-3 border-l-2 border-line">
        {f.sources.map((s, i) => {
          const l = srcLine(s);
          return (
            <li key={i} className="relative flex flex-col gap-0.5 pl-3">
              <span
                aria-hidden
                className={`absolute top-1 -left-1.5 size-2.5 rounded-full ${i === 0 ? 'bg-primary' : 'bg-line'}`}
              />
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                <SourceIcon kind={l.kind} />
                <span className="truncate">{l.title}</span>
                {i === 0 && (
                  <span className="shrink-0 text-xs font-normal text-muted">
                    {t('fpage.first')}
                  </span>
                )}
              </span>
              <span className="truncate text-xs text-muted">
                {s.author === me ? t('fpage.me') : nameOf(s.author)} · {formatTime(s.at)}
                {s.kind === 'message' && s.excerpt && `「${s.excerpt}」`}
              </span>
              <LinkButton className="self-start text-sm" onClick={() => goto(s)}>
                {t(`fpage.goto.${s.kind}`)}
              </LinkButton>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">{t('fpage.merged')}</p>
    </Card>
  );
}
