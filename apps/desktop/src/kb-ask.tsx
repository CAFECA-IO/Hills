/**
 * 問知識庫面板（ui-spec「知識庫 › 問知識庫」v0.51，D70）：在這台電腦上回答，只根據知識庫並附出處。
 * 剛打開 / 查詢中 / 有回答 / 找不到 / 未開啟 / 錯誤。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type AskCitation, type KbItem, type KbSnapshot } from './api';
import { formatDate, t, type MessageKey } from './i18n';
import { useKbAskStatus, type AskMessage, type AskScope } from './kbask';
import type { AskOptions } from './api';
import { navigate } from './nav';
import {
  Button,
  ChatComposer,
  ErrorText,
  IconButton,
  LinkButton,
  Markdown,
  SourceCard,
  TextInput,
} from './ui';

const BUSY: AskMessage['phase'][] = ['understanding', 'searching', 'answering'];

export interface AskApi {
  msgs: AskMessage[];
  send: (q: string, scope: AskScope | null, opts?: AskOptions) => Promise<void>;
  stop: () => void;
  reset: () => void;
  busy: boolean;
}

function pathOf(i: KbItem | undefined, data: KbSnapshot): string {
  if (!i) return '';
  const topic = data.topics.find((x) => x.id === i.topicId);
  const cat = topic && data.categories.find((c) => c.id === topic.categoryId);
  return [cat?.name, topic?.name].filter(Boolean).join(' › ');
}

function metaOf(c: AskCitation, data: KbSnapshot, nameOf: (id: string) => string): string {
  if (c.kind === 'pdf') return t('ask.source.attachment');
  const it = data.items.find((i) => i.key === c.key);
  return [
    t('ask.source.item'),
    pathOf(it, data),
    it ? nameOf(it.author) : '',
    it ? formatDate(it.updatedAt) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 同一出處（kind + key）的引用合併成一張參考卡（ui-spec v0.53）。 */
export function groupCitations(cs: AskCitation[]): AskCitation[][] {
  const groups = new Map<string, AskCitation[]>();
  for (const c of cs) {
    const k = `${c.kind}:${c.key}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups.values()];
}

/** 段落的小節路徑：去掉與標題重複的開頭（分類、主題、知識標題）。 */
function sectionLabel(c: AskCitation): string {
  if (c.kind === 'pdf')
    return [t('ask.source.page', { page: c.page ?? 1 }), ...c.heading].join(' · ');
  const i = c.heading.indexOf(c.title);
  return (i >= 0 ? c.heading.slice(i + 1) : c.heading.slice(-1)).join(' › ');
}

export function AskPanel({
  ask,
  data,
  nameOf,
  scope,
  onClearScope,
  onOpenItem,
  onNewKnowledge,
  onCollapse,
  overlay,
}: {
  ask: AskApi;
  data: KbSnapshot;
  nameOf: (id: string) => string;
  scope: AskScope | null;
  onClearScope: () => void;
  onOpenItem: (key: string) => void;
  /** 「存成知識…」與「新增一則知識」：預填標題與內容 */
  onNewKnowledge: (title: string, body: string) => void;
  onCollapse: () => void;
  /** 點星星時疊在面板上方的預覽卡 */
  overlay?: ReactNode;
}) {
  const status = useKbAskStatus();
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ready = status?.ready ?? false;
  const { msgs, busy } = ask;
  const lastMsg = msgs[msgs.length - 1];
  const followUps = !busy && !draft && lastMsg?.phase === 'done' ? lastMsg.followUps : [];

  useEffect(() => {
    if (!ready || msgs.length > 0) return;
    let live = true;
    api
      .kbaskSuggest()
      .then((q) => live && setSuggestions(q))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ready, msgs.length]);

  const last = msgs[msgs.length - 1];
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, last?.text, last?.phase]);

  const submit = (q: string) => {
    if (!q.trim() || busy) return;
    void ask.send(q, scope);
    setDraft('');
  };

  return (
    <aside
      aria-labelledby="kb-ask-title"
      className="relative flex w-[400px] shrink-0 flex-col overflow-hidden rounded-card bg-surface shadow-sm"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 pt-3 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="kb-ask-title" className="text-base font-bold">
            {t('ask.title')}
          </h2>
          <span className="text-xs text-muted">{t('ask.subtitle')}</span>
        </div>
        {msgs.length > 0 && (
          <Button variant="secondary" size="sm" onClick={ask.reset}>
            {t('ask.new')}
          </Button>
        )}
        <IconButton label={t('ask.collapse')} size="sm" onClick={onCollapse}>
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </IconButton>
      </header>

      {!ready ? (
        <NotEnabled />
      ) : (
        <>
          <div ref={scroller} className="scroll-panel flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
            {msgs.length === 0 ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm leading-6">{t('ask.empty')}</p>
                {suggestions.length > 0 && (
                  <>
                    <span className="text-xs font-semibold text-muted">{t('ask.suggest')}</span>
                    {suggestions.map((s) => (
                      <Button
                        key={s}
                        variant="secondary"
                        className="justify-start rounded-control text-left font-normal"
                        onClick={() => submit(s)}
                      >
                        {s}
                      </Button>
                    ))}
                  </>
                )}
                <p className="text-xs text-muted">{t('ask.suggest.note')}</p>
              </div>
            ) : (
              msgs.map((m, i) => (
                <Exchange
                  key={i}
                  idx={i}
                  m={m}
                  data={data}
                  nameOf={nameOf}
                  highlight={highlight}
                  onCite={(c) => {
                    setHighlight(`${i}-${c.n}`);
                    if (c.kind === 'item') onOpenItem(c.key);
                    else navigate({ page: 'files', fileKey: c.key });
                  }}
                  onActivateMark={(n) => {
                    setHighlight(`${i}-${n}`);
                    document
                      .getElementById(`ask-src-${i}-${n}`)
                      ?.scrollIntoView({ block: 'nearest' });
                  }}
                  onRephrase={() => setDraft(m.question)}
                  onRequery={(queries) => {
                    if (!busy) void ask.send(m.question, scope, { queries });
                  }}
                  onChoose={(option, focus) => {
                    if (busy) return;
                    void ask.send(`${m.question}（${option}）`, scope, {
                      clarified: true,
                      focus: focus && focus.length > 0 ? focus : null,
                      queries: m.opts.queries ?? null,
                    });
                  }}
                  onOther={() => {
                    setDraft(m.question);
                    document
                      .querySelector<HTMLTextAreaElement>(
                        'aside[aria-labelledby=kb-ask-title] textarea',
                      )
                      ?.focus();
                  }}
                  onNewKnowledge={onNewKnowledge}
                />
              ))
            )}
          </div>
          <div className="border-t border-line px-4 pt-2.5 pb-3">
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={() => submit(draft)}
              busy={busy}
              onStop={ask.stop}
              label={t('ask.input')}
              placeholder={t('ask.placeholder')}
              before={
                (scope || followUps.length > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {followUps.map((q) => (
                      <Button
                        key={q}
                        variant="secondary"
                        size="sm"
                        className="max-w-full rounded-full font-normal"
                        onClick={() => submit(q)}
                      >
                        <span className="truncate">{q}</span>
                      </Button>
                    ))}
                    {scope && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pr-1 pl-2.5 text-xs font-semibold text-primary">
                        {t('ask.scope', { name: scope.label })}
                        <IconButton
                          label={t('ask.scope.clear')}
                          size="sm"
                          className="h-5 min-w-5"
                          onClick={onClearScope}
                        >
                          ×
                        </IconButton>
                      </span>
                    )}
                  </div>
                )
              }
              hint={
                <span className="flex flex-wrap gap-x-1.5">
                  <span>
                    {scope ? t('ask.hint.scope', { name: scope.label }) : t('ask.hint.all')}
                  </span>
                  <span>·</span>
                  <span>{t('ask.hint.pdf')}</span>
                  <span className="flex-1" />
                  <span>{t('ask.hint.local')}</span>
                </span>
              }
            />
          </div>
        </>
      )}
      {overlay && <div className="absolute inset-x-3 top-16 z-10">{overlay}</div>}
    </aside>
  );
}

function Exchange({
  idx,
  m,
  data,
  nameOf,
  highlight,
  onCite,
  onActivateMark,
  onRephrase,
  onRequery,
  onChoose,
  onOther,
  onNewKnowledge,
}: {
  idx: number;
  m: AskMessage;
  data: KbSnapshot;
  nameOf: (id: string) => string;
  highlight: string | null;
  onCite: (c: AskCitation) => void;
  onActivateMark: (n: number) => void;
  onRephrase: () => void;
  onRequery: (queries: string[]) => void;
  onChoose: (option: string, focus: string[] | undefined) => void;
  onOther: () => void;
  onNewKnowledge: (title: string, body: string) => void;
}) {
  const busy = BUSY.includes(m.phase);
  const intent = m.intent?.intent;
  const kb = intent === 'kb' || intent === 'howto';
  const answer = m.answer;
  const titles: Record<number, string> = {};
  answer?.citations.forEach((c) => (titles[c.n] = c.title));
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [unhelpful, setUnhelpful] = useState(false);
  const groups = answer ? groupCitations(answer.citations) : [];
  const editQuery = () => setEditing(m.intent?.queries[0] ?? m.question);
  const steps: { key: MessageKey; params?: Record<string, string | number>; done: boolean }[] = [];
  if (m.intent && kb)
    steps.push({
      key: 'ask.step.understood',
      params: { q: m.intent.queries[0] ?? m.question },
      done: true,
    });
  else if (busy && !m.intent) {
    if (m.prep?.kind === 'indexing')
      steps.push({ key: 'ask.step.indexing', params: { n: m.prep.items }, done: false });
    else if (m.prep?.kind === 'loading') steps.push({ key: 'ask.step.loading', done: false });
    else steps.push({ key: 'ask.step.understanding', done: false });
  }
  if (m.found)
    steps.push({
      key: 'ask.step.found',
      params: { items: m.found.items, pdfs: m.found.pdfs },
      done: true,
    });
  else if (busy && m.intent && kb) steps.push({ key: 'ask.step.searching', done: false });
  // v0.54（D73）：初稿 → 檢驗 →（修正）→ 潤稿
  m.stages.forEach((st, i) =>
    steps.push({ key: `ask.step.${st}`, done: !busy || i < m.stages.length - 1 }),
  );
  if (m.phase === 'answering' && m.stages.length === 0)
    steps.push({ key: 'ask.step.answering', done: false });

  return (
    <div className="flex flex-col gap-2">
      <p className="max-w-[300px] self-end rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-5 whitespace-pre-wrap text-on-primary">
        {m.question}
      </p>
      {m.scope && (
        <span className="self-end text-2xs text-muted">
          {t('ask.scope', { name: m.scope.label })}
        </span>
      )}
      {busy && (
        <>
          <ol aria-live="polite" className="flex flex-col gap-1.5 text-xs">
            {steps.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`flex size-4 items-center justify-center rounded-full text-2xs ${s.done ? 'bg-st-online text-on-primary' : 'border-2 border-primary'}`}
                >
                  {s.done ? '✓' : ''}
                </span>
                <span className={s.done ? '' : 'font-semibold'}>{t(s.key, s.params)}</span>
              </li>
            ))}
          </ol>
          <Elapsed since={m.startedAt} />
        </>
      )}
      {!busy && m.intent && kb && (m.phase === 'done' || m.phase === 'notFound') && (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span
            aria-hidden="true"
            className="rounded-md bg-primary-soft px-1.5 text-2xs font-bold text-primary"
          >
            AI
          </span>
          {editing === null ? (
            <>
              <span className="min-w-0">
                {t(m.edited ? 'ask.understood.edited' : 'ask.understood', {
                  q: m.intent.queries[0] ?? m.question,
                })}
              </span>
              <LinkButton tone="muted" className="underline" onClick={editQuery}>
                {t('ask.understood.edit')}
              </LinkButton>
            </>
          ) : (
            <form
              className="flex w-full items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const q = editing.trim();
                if (!q) return;
                setEditing(null);
                onRequery([q.slice(0, 200)]);
              }}
            >
              <TextInput
                size="sm"
                className="min-w-0 flex-1"
                aria-label={t('ask.understood.label')}
                value={editing}
                maxLength={200}
                autoFocus
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
              <Button size="sm" type="submit" disabled={!editing.trim()}>
                {t('ask.understood.search')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
            </form>
          )}
        </span>
      )}
      {m.phase === 'done' && answer?.weak && (
        <div role="note" className="flex flex-col gap-1.5 rounded-control bg-cite-soft px-3 py-2.5">
          <b className="text-sm text-cite-text">{t('ask.weak.title')}</b>
          <p className="text-sm leading-5">{t('ask.weak.body')}</p>
          <span className="flex flex-wrap gap-3 text-xs">
            <LinkButton onClick={onRephrase}>{t('ask.notFound.rephrase')}</LinkButton>
            <LinkButton onClick={editQuery}>{t('ask.understood.edit.long')}</LinkButton>
          </span>
        </div>
      )}
      {m.phase === 'notFound' && (
        <div className="flex flex-col gap-2">
          <div role="note" className="rounded-control bg-cite-soft px-3 py-2.5">
            <b className="text-sm text-cite-text">{t('ask.notFound.title')}</b>
            <p className="text-sm leading-5">{t('ask.notFound.body')}</p>
          </div>
          <span className="text-xs font-semibold text-muted">{t('ask.notFound.next')}</span>
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={onRephrase}
          >
            {t('ask.notFound.rephrase')}
          </Button>
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={editQuery}
          >
            {t('ask.understood.edit.long')}
          </Button>
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={() => onNewKnowledge(m.question, '')}
          >
            {t('ask.notFound.add')}
          </Button>
        </div>
      )}
      {m.phase === 'clarify' && answer?.clarify && (
        <div className="flex flex-col gap-2">
          <p className="max-w-[320px] self-start rounded-2xl rounded-bl-sm bg-bg px-3 py-2 text-sm leading-5">
            {answer.clarify.question}
          </p>
          <div role="group" aria-label={answer.clarify.question} className="flex flex-col gap-1.5">
            {answer.clarify.options.map((o, i) => (
              <Button
                key={o}
                variant="secondary"
                className="justify-start rounded-control text-left font-normal"
                onClick={() => onChoose(o, answer.clarify?.focus?.[i])}
              >
                {o}
              </Button>
            ))}
            <LinkButton tone="muted" className="self-start text-xs underline" onClick={onOther}>
              {t('ask.clarify.other')}
            </LinkButton>
          </div>
        </div>
      )}
      {m.phase === 'done' && answer && (answer.unverified?.length ?? 0) > 0 && (
        <div role="note" className="flex flex-col gap-1 rounded-control bg-cite-soft px-3 py-2.5">
          <b className="text-sm text-cite-text">{t('ask.unverified.title')}</b>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs leading-5">
            {answer.unverified!.map((u, i) => (
              <li key={i}>
                「{u.quote}」：{t(`ask.issue.${u.kind}`)}
                {u.note ? ` · ${u.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {intent === 'people' && m.phase === 'done' && (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>{t('ask.people')}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate({ page: 'team' })}>
            {t('ask.people.go')}
          </Button>
        </div>
      )}
      {(m.text || answer?.answer) &&
        intent !== 'people' &&
        m.phase !== 'notFound' &&
        m.phase !== 'clarify' && (
          <Markdown
            variant="chat"
            className="text-sm leading-6"
            citations={
              answer
                ? {
                    titles,
                    uncited: answer.uncited,
                    doubtful: answer.unverified?.map((u) => u.quote),
                    onActivate: onActivateMark,
                  }
                : undefined
            }
          >
            {answer?.answer ?? m.text}
          </Markdown>
        )}
      {m.phase === 'done' && answer && answer.citations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-muted">{t('ask.sources')}</span>
          {groups.map((g) => {
            const c = g[0]!;
            return (
              <SourceCard
                key={`${c.kind}:${c.key}`}
                n={c.n}
                title={c.title}
                meta={metaOf(c, data, nameOf)}
                highlighted={g.some((x) => highlight === `${idx}-${x.n}`)}
                onOpen={() => onCite(c)}
                sections={g.map((x) => ({
                  n: x.n,
                  id: `ask-src-${idx}-${x.n}`,
                  label: sectionLabel(x),
                  excerpt: x.excerpt,
                }))}
              />
            );
          })}
        </div>
      )}
      {m.phase === 'done' && answer && kb && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="flex-1">{t('ask.footer', { count: groups.length })}</span>
          <LinkButton
            tone="muted"
            aria-expanded={unhelpful}
            onClick={() => setUnhelpful((v) => !v)}
          >
            {t('ask.unhelpful')}
          </LinkButton>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(answer.answer).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? t('md.copied') : t('ask.copy')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const refs = answer.citations
                .map(
                  (c) =>
                    `${c.n}. ${c.kind === 'pdf' ? `${c.title}（${t('ask.source.pdf', { page: c.page ?? 1 })}）` : c.title}`,
                )
                .join('\n');
              onNewKnowledge(m.question, `${answer.answer}\n\n## ${t('ask.sources')}\n\n${refs}\n`);
            }}
          >
            {t('ask.saveKb')}
          </Button>
        </div>
      )}
      {m.phase === 'done' && answer && kb && unhelpful && (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={onRephrase}
          >
            {t('ask.notFound.rephrase')}
          </Button>
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={editQuery}
          >
            {t('ask.understood.edit.long')}
          </Button>
          <Button
            variant="secondary"
            className="justify-start rounded-control font-normal"
            onClick={() => onNewKnowledge(m.question, '')}
          >
            {t('ask.notFound.add')}
          </Button>
        </div>
      )}
      {m.phase === 'cancelled' && <p className="text-xs text-muted">{t('ask.cancelled')}</p>}
      {m.phase === 'error' && (
        <div className="flex flex-col items-start gap-1.5">
          <ErrorText message={m.error} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate({ page: 'settings', group: 'ai' })}
          >
            {t('ask.goSettings')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 已經過幾秒（15 秒後才顯示；超過 2 分鐘時提示可以停止重試）。 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - since) / 1000);
  if (s < 15) return null;
  return (
    <p className="text-xs text-muted">{t(s >= 120 ? 'ask.elapsed.long' : 'ask.elapsed', { s })}</p>
  );
}

function NotEnabled() {
  const status = useKbAskStatus();
  const downloading = status?.enabled && status.components.some((c) => c.state === 'downloading');
  const llm = status?.components.find((c) => c.id === 'gemma-4-e4b-it');
  const gb = ((llm?.size ?? 4_977_171_584) / 1e9).toFixed(1);
  const docaiSize = (status?.components ?? [])
    .filter((c) => c.id !== 'gemma-4-e4b-it')
    .reduce((n, c) => n + c.size, 0);
  return (
    <div className="flex flex-1 flex-col items-start gap-3 px-5 py-6">
      <svg
        aria-hidden="true"
        width="44"
        height="44"
        viewBox="0 0 48 48"
        fill="none"
        stroke="var(--hills-primary)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="8" y="12" width="32" height="22" rx="4" />
        <path d="M18 40h12M24 34v6M17 23h4M27 23h4" />
      </svg>
      <b className="text-base">{t(downloading ? 'ask.off.downloading' : 'ask.off.title')}</b>
      <p className="text-sm leading-5">{t('ask.off.body')}</p>
      <ul className="list-disc pl-5 text-sm leading-6">
        <li>{t('ask.off.llm', { gb })}</li>
        {docaiSize > 0 && <li>{t('ask.off.docai', { mb: Math.round(docaiSize / 1e6) })}</li>}
      </ul>
      <p className="text-xs leading-5 text-muted">{t('ask.off.privacy')}</p>
      <Button onClick={() => navigate({ page: 'settings', group: 'ai' })}>
        {t('ask.goSettings')}
      </Button>
      <span className="text-xs text-muted">{t('ask.off.search')}</span>
    </div>
  );
}
