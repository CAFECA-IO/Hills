/** M1 對話（ui-spec「聊天」M1 畫面、technical-design §14）。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import { api, type ConvRow, type MemberView, type MessageView } from './api';
import {
  activeMention,
  convTitle,
  extractMentions,
  filterCandidates,
  insertMention,
  type MentionCandidate,
} from './chat-utils';
import { useLoad } from './hooks';
import { formatTime, t } from './i18n';
import { Button, ConfirmButton, ErrorText, Field, useAction } from './ui';

interface Props {
  members: MemberView[];
}

export function Chat({ members }: Props) {
  const convs = useLoad(api.conversations, ['convs', 'message', 'doc', 'roster']);
  const [current, setCurrent] = useState<string | null>(null);
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
        <button
          type="button"
          onClick={() => {
            setCreating(false);
            setCurrent(c.id);
          }}
          aria-current={c.id === current ? 'true' : undefined}
          className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm ${c.id === current ? 'bg-bg font-medium text-primary' : 'hover:bg-bg'}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {other && (
              <span
                aria-hidden
                className={
                  other.presence && other.presence !== 'Offline' ? 'text-primary' : 'text-muted'
                }
              >
                {other.presence && other.presence !== 'Offline' ? '●' : '○'}
              </span>
            )}
            <span className="truncate">{convTitle(c, me, nameOf)}</span>
          </span>
          {c.unread > 0 && (
            <span
              className="rounded-full bg-primary px-2 text-xs text-on-primary"
              aria-label={t('chat.unread', { count: c.unread })}
            >
              {c.unread}
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-[480px] gap-4">
      <aside className="flex w-60 shrink-0 flex-col gap-3">
        <Button onClick={() => setCreating(true)}>{t('chat.new')}</Button>
        <ErrorText message={convs.error} />
        {list.length === 0 && <p className="text-sm text-muted">{t('chat.empty')}</p>}
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
      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-line bg-surface">
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
          />
        ) : (
          <p className="m-auto text-sm text-muted">{t('chat.pick')}</p>
        )}
      </section>
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
        <legend className="mb-1 text-sm font-medium">{t('chat.new.pick')}</legend>
        {members.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-sm">
            <input
              type={group ? 'checkbox' : 'radio'}
              name="conv-member"
              checked={picked.includes(m.id)}
              onChange={() => toggle(m.id)}
            />
            {m.name}
          </label>
        ))}
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

function Conversation({
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
  const msgs = useLoad(() => api.messages(conv.id), ['message', 'doc', 'convs']);
  const [panel, setPanel] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const list = msgs.data ?? [];
  const last = list[list.length - 1];

  // 開著的對話：標記已讀、告知 Rust 端（不通知）
  useEffect(() => {
    void api.setActiveConv(conv.id, last?.createdAt).catch(() => undefined);
  }, [conv.id, last?.createdAt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [list.length]);

  const candidates: MentionCandidate[] = members
    .filter((m) => conv.members.includes(m.id) && m.id !== me)
    .map((m) => ({ id: m.id, name: m.name }));

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="truncate font-medium">{convTitle(conv, me, nameOf)}</h2>
          {conv.kind === 'group' && (
            <Button variant="secondary" className="px-3 py-1" onClick={() => setPanel((p) => !p)}>
              {t('chat.members')} · {t('chat.membersCount', { count: conv.members.length })}
            </Button>
          )}
        </header>
        <div className="flex-1 overflow-auto px-4 py-3" aria-live="polite">
          <ErrorText message={msgs.error} />
          {list.length === 0 && <p className="text-sm text-muted">{t('chat.noMessages')}</p>}
          <ul className="flex flex-col gap-3">
            {list.map((m) => (
              <MessageItem
                key={`${m.author}:${m.id}`}
                m={m}
                mine={m.author === me}
                nameOf={nameOf}
                me={me}
              />
            ))}
          </ul>
          <div ref={bottom} />
        </div>
        <Composer conv={conv.id} candidates={candidates} onSent={msgs.reload} />
      </div>
      {panel && conv.kind === 'group' && (
        <MembersPanel conv={conv} me={me} members={members} nameOf={nameOf} />
      )}
    </div>
  );
}

function MessageItem({
  m,
  mine,
  me,
  nameOf,
}: {
  m: MessageView;
  mine: boolean;
  me: string;
  nameOf: (id: string) => string;
}) {
  const mentioned = m.mentions.includes(me);
  return (
    <li className={`rounded px-2 py-1 ${mentioned ? 'border-l-2 border-primary bg-bg' : ''}`}>
      <p className="text-xs text-muted">
        <span className={`font-medium ${mine ? 'text-primary' : 'text-fg'}`}>
          {nameOf(m.author)}
        </span>{' '}
        {formatTime(m.createdAt)}
      </p>
      <div className="prose-hills text-sm break-words">
        {/* react-markdown 預設不轉譯原始 HTML（skipHtml），連結以新視窗開啟 */}
        <Markdown
          skipHtml
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline"
              >
                {children}
              </a>
            ),
            img: () => null,
          }}
        >
          {m.body}
        </Markdown>
      </div>
    </li>
  );
}

function Composer({
  conv,
  candidates,
  onSent,
}: {
  conv: string;
  candidates: MentionCandidate[];
  onSent: () => void;
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
          className="absolute bottom-full left-3 mb-1 w-56 rounded border border-line bg-surface py-1 shadow"
        >
          {options.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === hi}>
              <button
                type="button"
                className={`w-full px-3 py-1 text-left text-sm ${i === hi ? 'bg-bg text-primary' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText message={error} />
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          aria-label={t('chat.placeholder')}
          placeholder={t('chat.placeholder')}
          className="min-h-12 flex-1 resize-y rounded border border-line bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary"
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
    <aside className="flex w-64 shrink-0 flex-col gap-3 border-l border-line p-4 text-sm">
      <h3 className="font-medium">{t('chat.members')}</h3>
      <p className="text-xs text-muted">{t('chat.panel.historyNote')}</p>
      <ul className="flex flex-col gap-2">
        {conv.members.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2">
            <span className="truncate">
              {nameOf(id)}
              {id === conv.creator && (
                <span className="ml-1 rounded border border-line px-1 text-xs text-muted">
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
              <label key={m.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={adding.includes(m.id)}
                  onChange={() =>
                    setAdding((a) =>
                      a.includes(m.id) ? a.filter((x) => x !== m.id) : [...a, m.id],
                    )
                  }
                />
                {m.name}
              </label>
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
    </aside>
  );
}
