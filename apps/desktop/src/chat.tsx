import { AttachMenu, AttachmentCard, PendingUploads, UploadQueue } from './attachments';
import { cancel, loadPending, parseAttachments, resume } from './share';
/** M1 對話（ui-spec「聊天」M1 畫面、technical-design §14）。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  api,
  type ConvRow,
  type MemberView,
  type MessageView,
  type OfficeView,
  type Task,
  type TeamView,
} from './api';
import { knockTargets, lastPreview, pairOf, resolveLinked, runHeads, timeline } from './camp-utils';
import { Avatar, AvatarPair, stateLabel, statusTextClass } from './figures';
import { locationLabel } from './status';
import {
  ConvDrawer,
  ConvMountain,
  KnockHint,
  linkRowText,
  MessageActions,
  SystemRow,
} from './camp';
import {
  activeMention,
  convTitle,
  extractMentions,
  filterCandidates,
  insertMention,
  type MentionCandidate,
} from './chat-utils';
import { useLoad, useMediaQuery } from './hooks';
import { SaveToKb } from './kb';
import { formatClock, formatDate, formatTime, t } from './i18n';
import { navigate } from './nav';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  LinkButton,
  ListButton,
  Markdown,
  Radio,
  TextArea,
  useAction,
} from './ui';

interface Props {
  members: MemberView[];
  /** 我所屬小組的任務（焦點營地連結任務用） */
  tasks: Task[];
  teams: TeamView[];
  /** 辦公室（對話頂列顯示地點，D58） */
  offices?: OfficeView[];
  /** 從首頁開啟時直接進入的對話 */
  initial?: string | null;
  /** 前往出處（D64）：捲到並高亮這則訊息 */
  highlight?: string | null;
}

export function Chat({
  members,
  tasks,
  teams,
  offices = [],
  initial = null,
  highlight = null,
}: Props) {
  const convs = useLoad(api.conversations, ['convs', 'message', 'doc', 'roster']);
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    // 上次未完成的上傳（ui-spec「檔案分享」：下次開啟時詢問「繼續上傳？」）
    void loadPending()
      .then((list) => setPending(list.filter((j) => j.status === 'paused').map((j) => j.id)))
      .catch(() => undefined);
  }, []);
  const [current, setCurrent] = useState<string | null>(initial);
  const [creating, setCreating] = useState(false);
  const me = members.find((m) => m.isMe)?.id ?? '';
  const nameOf = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m.name]));
    return (id: string) => map.get(id) ?? t('chat.unknownMember');
  }, [members]);
  const list = convs.data ?? [];
  const selected = list.find((c) => c.id === current) ?? null;

  // 離開訊息頁時告知 Rust 端不再看任何對話（決定是否通知）
  useEffect(() => () => void api.setActiveConv(null).catch(() => undefined), []);

  const groups = list.filter((c) => c.kind === 'group');
  const dms = list.filter((c) => c.kind === 'dm');
  const row = (c: ConvRow) => {
    const other =
      c.kind === 'dm' ? members.find((m) => m.id !== me && c.members.includes(m.id)) : undefined;
    return (
      <li key={c.id}>
        <ListButton
          onClick={() => {
            setCreating(false);
            setCurrent(c.id);
          }}
          selected={c.id === current}
          className="justify-between"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            {other ? (
              <Avatar member={other} size={40} />
            ) : (
              <AvatarPair
                size={40}
                ringClass={c.id === current ? 'ring-primary-soft' : 'ring-surface'}
                members={pairOf(c, me)
                  .map((id) => members.find((m) => m.id === id))
                  .filter((m): m is MemberView => Boolean(m))}
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-baseline justify-between gap-2">
                <span className={`truncate ${c.unread > 0 ? 'font-bold' : 'font-semibold'}`}>
                  {convTitle(c, me, nameOf)}
                </span>
                {c.last && (
                  <span className="shrink-0 text-2xs text-muted">
                    {shortWhen(c.last.createdAt)}
                  </span>
                )}
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-muted">
                  {lastPreview(c.last) ?? t('chat.preview.files')}
                </span>
                {c.unread > 0 && (
                  <Badge tone="solid" label={t('chat.unread', { count: c.unread })}>
                    {c.unread}
                  </Badge>
                )}
              </span>
            </span>
          </span>
        </ListButton>
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PendingUploads
        count={pending.length}
        onResume={() => {
          pending.forEach(resume);
          setPending([]);
        }}
        onDiscard={() => {
          pending.forEach(cancel);
          setPending([]);
        }}
      />
      <div className="flex min-h-0 flex-1 gap-3 wide:gap-4">
        <aside className="scroll-panel flex w-60 shrink-0 flex-col gap-3">
          <Button onClick={() => setCreating(true)}>{t('chat.new')}</Button>
          <ErrorText message={convs.error} />
          {list.length === 0 && (
            <EmptyState art="chat" loading={convs.data === null && !convs.error}>
              {t('chat.empty')}
            </EmptyState>
          )}
          {groups.length > 0 && (
            <section>
              <h2 className="px-3 text-xs font-medium text-muted">{t('chat.groups')}</h2>
              <ul>{groups.map(row)}</ul>
            </section>
          )}
          {dms.length > 0 && (
            <section>
              <h2 className="px-3 text-xs font-medium text-muted">{t('chat.dms')}</h2>
              <ul>{dms.map(row)}</ul>
            </section>
          )}
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-card bg-surface shadow-sm">
          {creating ? (
            <NewConversation
              members={members.filter((m) => !m.isMe)}
              onCancel={() => setCreating(false)}
              onDone={(id) => {
                setCreating(false);
                setCurrent(id);
                convs.reload();
              }}
            />
          ) : selected ? (
            <Conversation
              key={selected.id}
              conv={selected}
              me={me}
              members={members}
              nameOf={nameOf}
              tasks={tasks}
              teams={teams}
              offices={offices}
              highlight={selected.id === initial ? highlight : null}
            />
          ) : (
            <p className="m-auto text-sm text-muted">{t('chat.pick')}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function NewConversation({
  members,
  onCancel,
  onDone,
}: {
  members: MemberView[];
  onCancel: () => void;
  onDone: (id: string) => void;
}) {
  const [group, setGroup] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const toggle = (id: string) =>
    setPicked((p) => (group ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : [id]));
  const submit = async () => {
    if (picked.length === 0) return setHint(t('chat.new.needMembers'));
    if (group && !name.trim()) return setHint(t('chat.new.needName'));
    setHint(null);
    const id = await run(() =>
      group ? api.createGroup(name, picked) : api.openDm(picked[0] ?? ''),
    );
    if (id) onDone(id);
  };
  return (
    <div className="flex flex-col gap-4 p-5">
      <h2 className="font-medium">{t('chat.new.title')}</h2>
      <div role="radiogroup" className="flex gap-2">
        {[false, true].map((g) => (
          <Button
            key={String(g)}
            role="radio"
            aria-checked={group === g}
            variant={group === g ? 'primary' : 'secondary'}
            onClick={() => {
              setGroup(g);
              setPicked([]);
            }}
          >
            {t(g ? 'chat.new.group' : 'chat.new.dm')}
          </Button>
        ))}
      </div>
      {group && <Field label={t('chat.new.groupName')} value={name} onChange={setName} />}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-muted">{t('chat.new.pick')}</legend>
        {members.map((m) =>
          group ? (
            <Checkbox
              key={m.id}
              label={m.name}
              checked={picked.includes(m.id)}
              onChange={() => toggle(m.id)}
            />
          ) : (
            <Radio
              key={m.id}
              name="conv-member"
              label={m.name}
              checked={picked.includes(m.id)}
              onChange={() => toggle(m.id)}
            />
          ),
        )}
      </fieldset>
      {hint && (
        <p role="alert" className="text-sm text-danger">
          {hint}
        </p>
      )}
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void submit()}>
          {t(group ? 'chat.new.create' : 'chat.new.open')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** 抽屜的手動開關在本次執行期間記住（ui-spec「聊天」焦點營地）。 */
let drawerPref: boolean | null = null;

function Conversation({
  conv,
  me,
  members,
  nameOf,
  tasks,
  teams,
  offices,
  highlight = null,
}: {
  conv: ConvRow;
  me: string;
  members: MemberView[];
  nameOf: (id: string) => string;
  tasks: Task[];
  teams: TeamView[];
  offices: OfficeView[];
  highlight?: string | null;
}) {
  const msgs = useLoad(() => api.messages(conv.id), ['message', 'doc', 'convs']);
  const wide = useMediaQuery('(min-width: 1600px)');
  const [drawer, setDrawer] = useState<boolean | null>(drawerPref);
  const open = drawer ?? wide;
  const toggle = () => {
    drawerPref = !open;
    setDrawer(!open);
  };
  const [mentioned, setMentioned] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const bottom = useRef<HTMLDivElement>(null);
  const list = msgs.data ?? [];
  const last = list[list.length - 1];
  const { task, missing } = resolveLinked(conv.task, tasks);
  const items = timeline(list, task);
  const heads = runHeads(items);
  const byId = new Map(members.map((m) => [m.id, m]));
  const myTeams = teams.filter((x) => x.members.includes(me)).map((x) => x.id);

  // 開著的對話：標記已讀、告知 Rust 端（不通知）
  useEffect(() => {
    void api.setActiveConv(conv.id, last?.createdAt).catch(() => undefined);
  }, [conv.id, last?.createdAt]);
  useEffect(() => {
    if (highlight) {
      const el = document.querySelector(`[data-msg="${CSS.escape(highlight)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        return;
      }
    }
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items.length, highlight]);

  const candidates: MentionCandidate[] = members
    .filter((m) => conv.members.includes(m.id) && m.id !== me)
    .map((m) => ({ id: m.id, name: m.name }));

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <ConvHead conv={conv} me={me} members={members} nameOf={nameOf} offices={offices} />
          <span className="flex-1" />
          <LinkButton
            className="text-xs"
            onClick={() => navigate({ page: 'files', conv: conv.id })}
          >
            {t('fpage.convFiles')}
          </LinkButton>
          <Button
            variant="secondary"
            className="h-8 px-3 py-0 text-xs"
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? t('camp.drawer.hide') : t('camp.drawer.show')}
            {conv.kind === 'group' &&
              ` · ${t('chat.membersCount', { count: conv.members.length })}`}
          </Button>
        </header>
        <ConvMountain
          conv={conv}
          task={task}
          missing={missing}
          tasks={tasks}
          teams={teams}
          nameOf={nameOf}
        />
        <div className="scroll-panel min-h-0 flex-1 px-4 py-3" aria-live="polite">
          <ErrorText message={msgs.error} />
          {list.length === 0 && <p className="text-sm text-muted">{t('chat.noMessages')}</p>}
          <ul className="flex flex-col gap-1.5">
            {items.map((it, i) =>
              it.type === 'step' ? (
                <SystemRow
                  key={`step:${it.step.id}`}
                  at={it.at}
                  lead={
                    it.step.assignee && byId.get(it.step.assignee) ? (
                      <Avatar member={byId.get(it.step.assignee)!} size={22} />
                    ) : undefined
                  }
                >
                  {t('camp.row.step', {
                    title: it.step.title,
                    name: it.step.assignee ? nameOf(it.step.assignee) : t('home.unassigned'),
                  })}
                </SystemRow>
              ) : it.type === 'link' ? (
                <SystemRow key={`${it.m.author}:${it.m.id}`} at={it.at}>
                  {linkRowText(it.m, tasks, nameOf)}
                </SystemRow>
              ) : (
                <MessageItem
                  key={`${it.m.author}:${it.m.id}`}
                  m={it.m}
                  highlight={it.m.id === highlight}
                  mine={it.m.author === me}
                  head={heads[i] ?? true}
                  nameOf={nameOf}
                  me={me}
                  author={members.find((x) => x.id === it.m.author)}
                  actions={
                    <MessageActions
                      m={it.m}
                      conv={conv}
                      me={me}
                      task={task}
                      teams={teams}
                      myTeams={myTeams}
                    />
                  }
                />
              ),
            )}
          </ul>
          <div ref={bottom} />
        </div>
        <UploadQueue conv={conv.id} />
        <KnockHint targets={knockTargets(conv, members, me, mentioned, now)} />
        <Composer
          conv={conv.id}
          candidates={candidates}
          onSent={msgs.reload}
          onMentions={setMentioned}
        />
      </div>
      {open && (
        <ConvDrawer
          conv={conv}
          me={me}
          members={members}
          msgs={list}
          task={task}
          missing={missing}
          nameOf={nameOf}
          membersPanel={<MembersPanel conv={conv} me={me} members={members} nameOf={nameOf} />}
        />
      )}
    </div>
  );
}

function MessageItem({
  m,
  mine,
  head,
  me,
  nameOf,
  author,
  actions,
  highlight = false,
}: {
  m: MessageView;
  /** 前往出處的那一則（短暫高亮） */
  highlight?: boolean;
  mine: boolean;
  /** 連續訊息的第一則：顯示頭像、名字與時間（D58） */
  head: boolean;
  me: string;
  nameOf: (id: string) => string;
  author: MemberView | undefined;
  /** 快速動作（滑過或聚焦時顯示） */
  actions?: React.ReactNode;
}) {
  const mentioned = m.mentions.includes(me);
  const [savingFile, setSavingFile] = useState<number | null>(null);
  const attachments = m.kind === 'files' ? parseAttachments(m.attachments) : [];
  return (
    <li
      data-msg={m.id}
      className={`group relative flex gap-2.5 rounded-control px-2 py-0.5 ${head ? 'mt-2' : ''} ${mine ? 'flex-row-reverse' : ''} ${mentioned ? 'border-l-2 border-primary' : ''} ${highlight ? 'hills-flash' : ''}`}
    >
      {actions && (
        <div
          className={`absolute top-0 z-10 hidden group-focus-within:block group-hover:block ${mine ? 'left-1' : 'right-1'}`}
        >
          {actions}
        </div>
      )}
      {!mine && (
        <span className="w-9 shrink-0">
          {head && author && <Avatar member={author} size={36} badge={false} />}
        </span>
      )}
      <div
        className={`flex max-w-[72%] min-w-0 flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
      >
        {head && (
          <p className="text-xs text-muted">
            {!mine && <span className="mr-1.5 font-bold text-fg">{nameOf(m.author)}</span>}
            {formatTime(m.createdAt)}
          </p>
        )}
        {m.body && (
          <div
            className={`px-3 py-2 shadow-sm ${mine ? 'rounded-2xl rounded-tr-sm bg-primary text-on-primary' : 'rounded-2xl rounded-tl-sm bg-bg'}`}
          >
            <Markdown variant="chat" className="text-sm">
              {m.body}
            </Markdown>
          </div>
        )}
        {attachments.map((a, i) => (
          <div key={i} className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
            <AttachmentCard a={a} author={author} createdAt={m.createdAt} />
            <LinkButton
              tone="muted"
              className="text-xs"
              aria-expanded={savingFile === i}
              onClick={() => setSavingFile(savingFile === i ? null : i)}
            >
              {t('camp.action.toKb')}
            </LinkButton>
            {savingFile === i && (
              <SaveToKb
                conv={m.conv}
                messageKey={`${m.author}:${m.id}`}
                defaultTitle={a.type === 'folder' ? a.name : a.manifest.name}
                attachment={i}
                onDone={() => setSavingFile(null)}
              />
            )}
          </div>
        ))}
      </div>
    </li>
  );
}

/** 對話頂列（D58）：私訊顯示對方頭像、狀態、地點與狀態文字；群組顯示交疊頭像。 */
function ConvHead({
  conv,
  me,
  members,
  nameOf,
  offices,
}: {
  conv: ConvRow;
  me: string;
  members: MemberView[];
  nameOf: (id: string) => string;
  offices: OfficeView[];
}) {
  const other =
    conv.kind === 'dm'
      ? members.find((m) => m.id !== me && conv.members.includes(m.id))
      : undefined;
  const pair = pairOf(conv, me)
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is MemberView => Boolean(m));
  return (
    <div className="flex min-w-0 items-center gap-3">
      {other ? <Avatar member={other} size={44} /> : <AvatarPair members={pair} size={40} />}
      <div className="flex min-w-0 flex-col">
        <h2 className="truncate font-bold">{convTitle(conv, me, nameOf)}</h2>
        {other && (
          <p className="truncate text-xs">
            <span className={`font-semibold ${statusTextClass[other.presence ?? 'Offline']}`}>
              {stateLabel(other.presence)}
            </span>
            <span className="text-muted">
              {` · ${locationLabel(other.location, offices)}`}
              {other.note && ` · ${other.note}`}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/** 對話列表的時間：今天顯示時刻，其他顯示日期。 */
function shortWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? formatClock(ms) : formatDate(ms);
}

function Composer({
  conv,
  candidates,
  onSent,
  onMentions,
}: {
  conv: string;
  candidates: MentionCandidate[];
  onSent: () => void;
  /** 草稿中 @ 到的成員（敲門提示用） */
  onMentions?: (ids: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [hi, setHi] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // 插入提及後，在下一次繪製前同步設定游標（避免與接著輸入的字互相干擾）
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (c !== null && area.current) {
      pendingCaret.current = null;
      area.current.focus();
      area.current.setSelectionRange(c, c);
    }
  }, [text]);
  const { busy, error, attempt } = useAction();
  const mentionKey = extractMentions(text, picked).join(',');
  const onMentionsRef = useRef(onMentions);
  useEffect(() => {
    onMentionsRef.current = onMentions;
  });
  useEffect(() => {
    onMentionsRef.current?.(mentionKey ? mentionKey.split(',') : []);
  }, [mentionKey]);
  const mention = activeMention(text, caret);
  const options = mention ? filterCandidates(candidates, mention.query) : [];

  const choose = (c: MentionCandidate) => {
    if (!mention) return;
    const next = insertMention(text, caret, mention.start, c.name);
    setText(next.text);
    setCaret(next.caret);
    setPicked((p) => (p.some((x) => x.id === c.id) ? p : [...p, c]));
    pendingCaret.current = next.caret;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    const ok = await attempt(() => api.sendMessage(conv, body, extractMentions(body, picked)));
    if (ok) {
      setText('');
      setPicked([]);
      onSent();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // 中文輸入法選字中
    if (options.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = options[hi] ?? options[0];
        if (c) choose(c);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative border-t border-line p-3">
      {options.length > 0 && (
        <ul
          role="listbox"
          className="absolute bottom-full left-3 mb-1 w-56 rounded-control border border-line bg-surface py-1 shadow"
        >
          {options.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === hi}>
              <ListButton
                tabIndex={-1}
                selected={i === hi}
                className="rounded-none py-1"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
              >
                {c.name}
              </ListButton>
            </li>
          ))}
        </ul>
      )}
      <ErrorText message={error} />
      <div className="flex items-end gap-2">
        <AttachMenu conv={conv} />
        <TextArea
          ref={area}
          aria-label={t('chat.placeholder')}
          placeholder={t('chat.placeholder')}
          className="min-h-12 flex-1 resize-y"
          value={text}
          rows={2}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setHi(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
        />
        <Button disabled={busy || !text.trim()} onClick={() => void send()}>
          {t('chat.send')}
        </Button>
      </div>
    </div>
  );
}

function MembersPanel({
  conv,
  me,
  members,
  nameOf,
}: {
  conv: ConvRow;
  me: string;
  members: MemberView[];
  nameOf: (id: string) => string;
}) {
  const isCreator = conv.creator === me;
  const [adding, setAdding] = useState<string[]>([]);
  const { busy, error, attempt } = useAction();
  const others = members.filter((m) => !conv.members.includes(m.id));
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <p className="text-xs text-muted">{t('chat.panel.historyNote')}</p>
      <ul className="flex flex-col gap-2">
        {conv.members.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2">
            <span className="truncate">
              {nameOf(id)}
              {id === conv.creator && (
                <span className="ml-1 rounded-control border border-line px-1 text-xs text-muted">
                  {t('chat.panel.creator')}
                </span>
              )}
            </span>
            {isCreator && id !== me && (
              <ConfirmButton
                label={t('chat.panel.remove')}
                message={t('chat.panel.remove.confirm', { name: nameOf(id) })}
                onConfirm={async () => {
                  await attempt(() => api.removeConvMember(conv.id, id));
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {isCreator ? (
        others.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium">{t('chat.panel.add')}</legend>
            {others.map((m) => (
              <Checkbox
                key={m.id}
                label={m.name}
                checked={adding.includes(m.id)}
                onChange={() =>
                  setAdding((a) => (a.includes(m.id) ? a.filter((x) => x !== m.id) : [...a, m.id]))
                }
              />
            ))}
            <Button
              className="mt-2"
              disabled={busy || adding.length === 0}
              onClick={async () => {
                if (await attempt(() => api.addConvMembers(conv.id, adding))) setAdding([]);
              }}
            >
              {t('chat.panel.add')}
            </Button>
          </fieldset>
        )
      ) : (
        <p className="text-xs text-muted">{t('chat.panel.creatorOnly')}</p>
      )}
      <ErrorText message={error} />
    </div>
  );
}
