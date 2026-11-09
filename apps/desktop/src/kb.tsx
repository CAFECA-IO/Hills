/** 知識庫「星空」（ui-spec「知識庫」，D42；technical-design §16.11）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  api,
  type ConvRow,
  type KbCategory,
  type KbInput,
  type KbItem,
  type KbSnapshot,
  type KbTopic,
  type MemberView,
} from './api';
import { Moon } from './figures';
import { useLoad, useSize } from './hooks';
import { formatTime, t, type MessageKey } from './i18n';
import {
  activeCategories,
  activeTopics,
  citations,
  layout,
  matches,
  placeOf,
  relations,
  summary,
  upToWeek,
  weekOf,
  weekly,
  type RelationKind,
} from './kb-utils';
import { PageHead } from './layout';
import {
  Button,
  Checkbox,
  Chip,
  ConfirmButton,
  Dialog,
  EmptyState,
  ErrorText,
  Field,
  LinkButton,
  ListButton,
  Pressable,
  SegmentedControl,
  Select,
  Slider,
  TextArea,
  TextInput,
  useAction,
} from './ui';

const REL_COLOR: Record<RelationKind, string> = {
  ref: 'var(--hills-rel-ref)',
  topic: 'var(--hills-rel-topic)',
  task: 'var(--hills-rel-task)',
  conv: 'var(--hills-rel-conv)',
};
/** 線型：引用 實線、同主題 長虛線、同任務 點線、同對話 短虛線 */
const REL_DASH: Record<RelationKind, string | undefined> = {
  ref: undefined,
  topic: '10 6',
  task: '1.5 5',
  conv: '4 4',
};
const relName = (k: RelationKind) => t(`kb.rel.${k}` as MessageKey);

interface Props {
  members: MemberView[];
  isAdmin: boolean;
  timezone: string;
  onOpenConv: (conv: string) => void;
}

export function Knowledge({ members, isAdmin, timezone, onOpenConv }: Props) {
  const kb = useLoad(api.kb, ['doc', 'org', 'roster']);
  const convs = useLoad(api.conversations, ['convs']);
  const [view, setView] = useState<'sky' | 'list'>('sky');
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [editing, setEditing] = useState<KbInput | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const data: KbSnapshot = kb.data ?? { categories: [], topics: [], items: [] };
  const me = members.find((m) => m.isMe)?.id ?? '';
  const canEdit = (i: KbItem) => i.author === me || isAdmin;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? t('kb.unknownAuthor');
  const shown = useMemo(() => upToWeek(data.items, week, timezone), [data.items, week, timezone]);
  const selected = data.items.find((i) => i.key === sel) ?? null;
  const thisWeek = weekOf(now, timezone);
  const blank = (): KbInput => {
    const topic = activeTopics(data.topics)[0];
    return { key: null, title: '', body: '', tags: [], topicId: topic?.id ?? '', refs: [] };
  };
  const toInput = (i: KbItem): KbInput => ({
    key: i.key,
    title: i.title,
    body: i.body,
    tags: i.tags,
    topicId: i.topicId,
    refs: i.refs,
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead
        title={t('kb.title')}
        subtitle={t('kb.subtitle', { count: data.items.length })}
        actions={
          <>
            <SegmentedControl
              label={t('kb.title')}
              value={view}
              onChange={setView}
              options={(['sky', 'list'] as const).map((k) => ({
                value: k,
                label: t(`kb.view.${k}` as MessageKey),
              }))}
            />
            <Button onClick={() => setEditing(blank())}>{t('kb.new')}</Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('kb.search')}
          aria-label={t('kb.search')}
          className="h-9 w-64 rounded-full px-4"
        />
        {activeCategories(data.categories).map((c) => (
          <Chip
            key={c.id}
            selected={catFilter === c.id}
            onClick={() => setCatFilter((f) => (f === c.id ? null : c.id))}
            className="h-8 px-3"
          >
            {c.name}
          </Chip>
        ))}
        <ErrorText message={kb.error} />
      </div>
      {view === 'sky' ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <Starfield
            data={data}
            items={shown}
            q={q}
            catFilter={catFilter}
            selected={sel}
            onSelect={setSel}
            thisWeek={thisWeek}
            timezone={timezone}
            now={now}
          />
          <PreviewCard
            item={selected}
            data={data}
            onOpen={() => selected && setReading(selected.key)}
            onSelect={setSel}
            convs={convs.data ?? []}
          />
        </div>
      ) : (
        <KbList
          data={data}
          items={shown.filter((i) => matches(i, q))}
          onOpen={(k) => setReading(k)}
        />
      )}
      <Timeline
        items={data.items}
        now={now}
        timezone={timezone}
        week={week}
        onWeek={setWeek}
        thisWeek={thisWeek}
      />
      {editing && (
        <KbEditor
          initial={editing}
          data={data}
          onClose={() => setEditing(null)}
          onSaved={(k) => {
            setEditing(null);
            setSel(k);
            kb.reload();
          }}
        />
      )}
      {reading && (
        <KbReader
          item={data.items.find((i) => i.key === reading) ?? null}
          data={data}
          nameOf={nameOf}
          canEdit={canEdit}
          convs={convs.data ?? []}
          onClose={() => setReading(null)}
          onEdit={(i) => {
            setReading(null);
            setEditing(toInput(i));
          }}
          onOpenItem={(k) => {
            setReading(k);
            setSel(k);
          }}
          onOpenConv={onOpenConv}
          onDeleted={() => {
            setReading(null);
            setSel(null);
            kb.reload();
          }}
        />
      )}
    </div>
  );
}

// ── 星空 ─────────────────────────────────────────────────────

function Starfield({
  data,
  items,
  q,
  catFilter,
  selected,
  onSelect,
  thisWeek,
  timezone,
  now,
}: {
  data: KbSnapshot;
  items: KbItem[];
  q: string;
  catFilter: string | null;
  selected: string | null;
  onSelect: (k: string | null) => void;
  thisWeek: string;
  timezone: string;
  now: number;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useSize(box);
  const w = Math.max(400, Math.round(size?.w ?? 900));
  const h = Math.max(240, Math.round(size?.h ?? 480));
  const lay = useMemo(
    () => layout(data.categories, data.topics, items, w, h),
    [data.categories, data.topics, items, w, h],
  );
  const cites = useMemo(() => citations(items), [items]);
  const sel = items.find((i) => i.key === selected) ?? null;
  const rels = sel ? relations(sel, items, data.topics) : [];
  const dim = (i: KbItem) =>
    (catFilter !== null && placeOf(i, data.topics).categoryId !== catFilter) || !matches(i, q);
  const selPos = sel ? lay.stars.get(sel.key) : undefined;
  return (
    <div
      ref={setBox}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-card"
      style={{
        background: 'linear-gradient(var(--hills-night-top), var(--hills-night-bottom))',
      }}
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="group"
        aria-label={t('kb.sky.label', { count: items.length })}
        className="block"
        onClick={(e) => e.target === e.currentTarget && onSelect(null)}
      >
        <Moon x={w - 48} y={44} r={16} now={now} />
        {lay.labels.map((l) => (
          <text
            key={l.id}
            x={l.x}
            y={l.y}
            textAnchor="middle"
            fontSize={13}
            fill="var(--hills-night-text)"
            opacity={catFilter && catFilter !== l.id ? 0.3 : 0.75}
          >
            {l.name}
          </text>
        ))}
        {lay.lines.map((ln) => {
          const a = lay.stars.get(ln.from);
          const b = lay.stars.get(ln.to);
          if (!a || !b) return null;
          return (
            <line
              key={`${ln.from}-${ln.to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--hills-star-dim)"
              strokeWidth={1}
              opacity={0.55}
            />
          );
        })}
        {selPos &&
          rels.map((r) => {
            const b = lay.stars.get(r.key);
            if (!b) return null;
            return (
              <line
                key={`rel-${r.key}`}
                x1={selPos.x}
                y1={selPos.y}
                x2={b.x}
                y2={b.y}
                stroke={REL_COLOR[r.kind]}
                strokeWidth={1.8}
                strokeDasharray={REL_DASH[r.kind]}
                strokeLinecap="round"
              />
            );
          })}
        {selPos && (
          <line
            x1={selPos.x}
            y1={selPos.y}
            x2={w}
            y2={selPos.y}
            stroke="var(--hills-night-text)"
            strokeDasharray="3 5"
            opacity={0.45}
          />
        )}
        {items.map((i) => {
          const p = lay.stars.get(i.key);
          if (!p) return null;
          const r = 3.5 + Math.min(7, (cites.get(i.key) ?? 0) * 1.6);
          const isNew = weekOf(i.createdAt, timezone) === thisWeek;
          const on = i.key === selected;
          return (
            <g
              key={i.key}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`${i.title}${isNew ? `，${t('kb.new.badge')}` : ''}`}
              onClick={() => onSelect(on ? null : i.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(on ? null : i.key);
                }
              }}
              opacity={dim(i) ? 0.25 : 1}
              className="cursor-pointer focus:outline-none [&:focus-visible>circle.focus]:opacity-100"
            >
              <circle cx={p.x} cy={p.y} r={r + 10} fill="transparent" />
              <circle
                className="focus"
                cx={p.x}
                cy={p.y}
                r={r + 6}
                fill="none"
                stroke="var(--hills-primary)"
                strokeWidth={2}
                opacity={0}
              />
              <circle cx={p.x} cy={p.y} r={r * 2.2} fill="var(--hills-star)" opacity={0.12} />
              <circle cx={p.x} cy={p.y} r={r} fill="var(--hills-star)" />
              {on && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r + 4}
                  fill="none"
                  stroke="var(--hills-cloud)"
                  strokeWidth={2}
                />
              )}
              {isNew && (
                <>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r + 7}
                    fill="none"
                    stroke="var(--hills-star)"
                    strokeDasharray="2 3"
                    opacity={0.8}
                  />
                  <text x={p.x + r + 9} y={p.y - r - 4} fontSize={10} fill="var(--hills-star)">
                    {t('kb.new.badge')}
                  </text>
                </>
              )}
              {(on || r > 6) && (
                <text
                  x={p.x}
                  y={p.y + r + 14}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--hills-night-text)"
                >
                  {i.title.length > 16 ? `${i.title.slice(0, 16)}…` : i.title}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul
        aria-label={t('kb.legend')}
        className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-control bg-night-top/70 px-3 py-1.5 text-2xs text-night-text"
      >
        {(['ref', 'topic', 'task', 'conv'] as const).map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <svg width={22} height={6} aria-hidden>
              <line
                x1={0}
                y1={3}
                x2={22}
                y2={3}
                stroke={REL_COLOR[k]}
                strokeWidth={2}
                strokeDasharray={REL_DASH[k]}
              />
            </svg>
            {relName(k)}
          </li>
        ))}
      </ul>
      {items.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-night-text">
          {t('kb.empty')}
        </p>
      )}
    </div>
  );
}

function pathOf(i: KbItem, data: KbSnapshot): string {
  const { topic, categoryId } = placeOf(i, data.topics);
  const cat = data.categories.find((c) => c.id === categoryId);
  return `${cat?.name ?? '?'} › ${topic?.name ?? '?'}`;
}

function PreviewCard({
  item,
  data,
  onOpen,
  onSelect,
  convs,
}: {
  item: KbItem | null;
  data: KbSnapshot;
  onOpen: () => void;
  onSelect: (k: string) => void;
  convs: ConvRow[];
}) {
  const [sharing, setSharing] = useState(false);
  if (!item) {
    return (
      <aside className="flex w-72 shrink-0 items-center justify-center rounded-card bg-surface p-4 text-center text-sm text-muted shadow-sm wide:w-80">
        {t('kb.preview.hint')}
      </aside>
    );
  }
  const rels = relations(item, data.items, data.topics);
  const cited = citations(data.items).get(item.key) ?? 0;
  return (
    <aside className="scroll-panel flex w-72 shrink-0 flex-col gap-2 rounded-card bg-surface p-4 shadow-sm wide:w-80">
      <span className="text-xs text-muted">{pathOf(item, data)}</span>
      <h2 className="text-lg leading-snug font-bold">{item.title}</h2>
      <p className="text-sm text-muted">{summary(item.body, 90) || t('kb.noBody')}</p>
      <span className="text-xs text-muted">
        {t('kb.cited', { count: cited })} · {t('kb.relCount', { count: rels.length })}
      </span>
      {rels.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {rels.slice(0, 8).map((r) => {
            const o = data.items.find((i) => i.key === r.key);
            return (
              <li key={r.key}>
                <Pressable
                  className="flex w-full items-center gap-2 rounded-sm hover:text-primary"
                  onClick={() => onSelect(r.key)}
                >
                  <svg width={16} height={6} aria-hidden className="shrink-0">
                    <line
                      x1={0}
                      y1={3}
                      x2={16}
                      y2={3}
                      stroke={REL_COLOR[r.kind]}
                      strokeWidth={2}
                      strokeDasharray={REL_DASH[r.kind]}
                    />
                  </svg>
                  <span className="truncate">{o?.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{relName(r.kind)}</span>
                </Pressable>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-auto flex gap-2 pt-2">
        <Button className="h-8 px-3 py-0" onClick={onOpen}>
          {t('kb.open')}
        </Button>
        <Button variant="secondary" className="h-8 px-3 py-0" onClick={() => setSharing(true)}>
          {t('kb.share')}
        </Button>
      </div>
      {sharing && <ShareToConv item={item} convs={convs} onClose={() => setSharing(false)} />}
    </aside>
  );
}

function ShareToConv({
  item,
  convs,
  onClose,
}: {
  item: KbItem;
  convs: ConvRow[];
  onClose: () => void;
}) {
  const [conv, setConv] = useState(convs[0]?.id ?? '');
  const { busy, error, attempt } = useAction();
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line p-2 text-sm">
      <Field label={t('kb.share.to')}>
        <Select size="sm" value={conv} onChange={(e) => setConv(e.target.value)}>
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || t('kb.share.dm')}
            </option>
          ))}
        </Select>
      </Field>
      {done && <p className="text-xs text-st-online-text">{t('kb.share.done')}</p>}
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" className="h-8 px-3 py-0" onClick={onClose}>
          {t('common.close')}
        </Button>
        <Button
          className="h-8 px-3 py-0"
          disabled={busy || !conv || done}
          onClick={async () => {
            const body = `${t('kb.share.prefix')}**${item.title}**\n\n${summary(item.body, 140)}`;
            if (await attempt(() => api.sendMessage(conv, body, []))) setDone(true);
          }}
        >
          {t('kb.share.send')}
        </Button>
      </div>
    </div>
  );
}

// ── 時間軸 ───────────────────────────────────────────────────

function Timeline({
  items,
  now,
  timezone,
  week,
  onWeek,
  thisWeek,
}: {
  items: KbItem[];
  now: number;
  timezone: string;
  week: string | null;
  onWeek: (w: string | null) => void;
  thisWeek: string;
}) {
  const weeks = weekly(items, now, timezone);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const idx = week
    ? Math.max(
        0,
        weeks.findIndex((w) => w.week === week),
      )
    : weeks.length - 1;
  const newThisWeek = weeks.find((w) => w.week === thisWeek)?.count ?? 0;
  const shownCount = upToWeek(items, week, timezone).length;
  return (
    <section className="flex h-20 shrink-0 items-center gap-4 rounded-card bg-surface px-4 shadow-sm">
      <div className="flex w-44 shrink-0 flex-col">
        <span className="text-xs font-bold">{t('kb.timeline.title')}</span>
        <span className="text-xs text-muted">
          {t('kb.timeline.summary', { count: shownCount, added: newThisWeek })}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-8 items-end gap-1" aria-hidden>
          {weeks.map((w, i) => (
            <span
              key={w.week}
              className={`min-w-1 flex-1 rounded-t ${i <= idx ? 'bg-primary' : 'bg-line'}`}
              style={{ height: `${Math.max(8, (w.count / max) * 100)}%` }}
              title={`${w.week} · ${w.count}`}
            />
          ))}
        </div>
        <Slider
          min={0}
          max={Math.max(0, weeks.length - 1)}
          value={idx}
          aria-label={t('kb.timeline.slider')}
          aria-valuetext={weeks[idx]?.week}
          onChange={(e) => {
            const i = Number(e.target.value);
            onWeek(i >= weeks.length - 1 ? null : (weeks[i]?.week ?? null));
          }}
          className="w-full"
        />
      </div>
      <div className="flex w-28 shrink-0 flex-col items-end gap-1 text-xs">
        <span className="font-bold">{weeks[idx]?.week}</span>
        {week && (
          <LinkButton className="underline" onClick={() => onWeek(null)}>
            {t('kb.timeline.now')}
          </LinkButton>
        )}
      </div>
    </section>
  );
}

// ── 清單（含分類 / 主題管理） ─────────────────────────────────

function KbList({
  data,
  items,
  onOpen,
}: {
  data: KbSnapshot;
  items: KbItem[];
  onOpen: (k: string) => void;
}) {
  const cats = activeCategories(data.categories);
  const topics = activeTopics(data.topics);
  const cites = citations(data.items);
  return (
    <div className="scroll-panel min-h-0 flex-1 rounded-card bg-surface p-4 shadow-sm">
      {cats.length === 0 && <EmptyState art="knowledge">{t('kb.empty')}</EmptyState>}
      <ul className="flex flex-col gap-4">
        {cats.map((c) => (
          <li key={c.id}>
            <MetaRow kind="category" item={c} peers={cats} />
            <ul className="mt-1 flex flex-col gap-2 border-l border-line pl-4">
              {topics
                .filter((tp) => tp.categoryId === c.id)
                .map((tp) => (
                  <li key={tp.id}>
                    <MetaRow kind="topic" item={tp} peers={topics} />
                    <ul className="mt-1 flex flex-col">
                      {items
                        .filter((i) => placeOf(i, data.topics).topic?.id === tp.id)
                        .map((i) => (
                          <li key={i.key}>
                            <ListButton
                              onClick={() => onOpen(i.key)}
                              className="justify-between px-2 py-1"
                            >
                              <span className="truncate">{i.title}</span>
                              <span className="shrink-0 text-xs text-muted">
                                {t('kb.cited', { count: cites.get(i.key) ?? 0 })}
                              </span>
                            </ListButton>
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetaRow({
  kind,
  item,
  peers,
}: {
  kind: 'category' | 'topic';
  item: KbCategory | KbTopic;
  peers: (KbCategory | KbTopic)[];
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'merge'>('view');
  const [name, setName] = useState(item.name);
  const others = peers.filter(
    (p) =>
      p.id !== item.id &&
      (kind === 'category' || (p as KbTopic).categoryId === (item as KbTopic).categoryId),
  );
  const [into, setInto] = useState(others[0]?.id ?? '');
  const { busy, error, attempt } = useAction();
  const head = kind === 'category' ? 'text-base font-bold' : 'text-sm font-semibold text-muted';
  return (
    <div className="flex flex-wrap items-center gap-2">
      {mode === 'rename' ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await attempt(() => api.kbRename(kind, item.id, name))) setMode('view');
          }}
        >
          <TextInput
            size="sm"
            autoFocus
            value={name}
            maxLength={60}
            aria-label={t('kb.meta.rename')}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" className="h-7 px-2 py-0 text-xs" disabled={busy}>
            {t('kb.save')}
          </Button>
        </form>
      ) : (
        <span className={head}>{item.name}</span>
      )}
      {mode === 'merge' && (
        <span className="flex items-center gap-2 text-xs">
          {t('kb.meta.mergeInto')}
          <Select size="sm" value={into} onChange={(e) => setInto(e.target.value)}>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Button
            className="h-7 px-2 py-0 text-xs"
            disabled={busy || !into}
            onClick={async () => {
              if (await attempt(() => api.kbMerge(kind, item.id, into))) setMode('view');
            }}
          >
            {t('kb.meta.merge')}
          </Button>
        </span>
      )}
      <span className="flex gap-1 text-xs">
        <LinkButton tone="muted" onClick={() => setMode(mode === 'rename' ? 'view' : 'rename')}>
          {t('kb.meta.rename')}
        </LinkButton>
        {others.length > 0 && (
          <LinkButton tone="muted" onClick={() => setMode(mode === 'merge' ? 'view' : 'merge')}>
            {t('kb.meta.merge')}
          </LinkButton>
        )}
      </span>
      <ErrorText message={error} />
    </div>
  );
}

// ── 分類 / 主題選擇（可直接新建） ─────────────────────────────

/** 選擇主題；可直接新建分類與主題。回傳主題 id。 */
function TopicPicker({
  data,
  topicId,
  onChange,
}: {
  data: KbSnapshot;
  topicId: string;
  onChange: (topicId: string) => void;
}) {
  const cats = activeCategories(data.categories);
  const topics = activeTopics(data.topics);
  const current = topics.find((x) => x.id === topicId);
  const [cat, setCat] = useState(current?.categoryId ?? cats[0]?.id ?? '');
  const [newCat, setNewCat] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const { busy, error, attempt } = useAction();
  const inCat = topics.filter((x) => x.categoryId === cat);
  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      <Field label={t('kb.field.category')}>
        <Select
          size="sm"
          value={cat}
          onChange={(e) => {
            setCat(e.target.value);
            const first = topics.find((x) => x.categoryId === e.target.value);
            onChange(first?.id ?? '');
          }}
        >
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="__new">{t('kb.field.newCategory')}</option>
        </Select>
        {cat === '__new' && (
          <span className="flex gap-1">
            <TextInput
              size="sm"
              value={newCat}
              maxLength={60}
              aria-label={t('kb.field.newCategory')}
              onChange={(e) => setNewCat(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              className="h-8 px-2 py-0 text-xs"
              disabled={busy || !newCat.trim()}
              onClick={async () => {
                let id = '';
                if (await attempt(async () => (id = await api.kbCreateCategory(newCat)))) {
                  setCat(id);
                  setNewCat('');
                }
              }}
            >
              {t('kb.create')}
            </Button>
          </span>
        )}
      </Field>
      <Field label={t('kb.field.topic')}>
        <Select
          size="sm"
          value={inCat.some((x) => x.id === topicId) ? topicId : '__new'}
          onChange={(e) => onChange(e.target.value === '__new' ? '' : e.target.value)}
          disabled={cat === '__new'}
        >
          {inCat.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
          <option value="__new">{t('kb.field.newTopic')}</option>
        </Select>
        {cat !== '__new' && !inCat.some((x) => x.id === topicId) && (
          <span className="flex gap-1">
            <TextInput
              size="sm"
              value={newTopic}
              maxLength={60}
              aria-label={t('kb.field.newTopic')}
              onChange={(e) => setNewTopic(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              className="h-8 px-2 py-0 text-xs"
              disabled={busy || !newTopic.trim() || !cat}
              onClick={async () => {
                let id = '';
                if (await attempt(async () => (id = await api.kbCreateTopic(cat, newTopic)))) {
                  onChange(id);
                  setNewTopic('');
                }
              }}
            >
              {t('kb.create')}
            </Button>
          </span>
        )}
      </Field>
      <ErrorText message={error} />
    </div>
  );
}

// ── 編輯 ─────────────────────────────────────────────────────

function KbEditor({
  initial,
  data,
  onClose,
  onSaved,
}: {
  initial: KbInput;
  data: KbSnapshot;
  onClose: () => void;
  onSaved: (key: string) => void;
}) {
  const [v, setV] = useState<KbInput>(initial);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [preview, setPreview] = useState(false);
  const [refQ, setRefQ] = useState('');
  const [missing, setMissing] = useState<{ title?: boolean; topic?: boolean }>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const { busy, error, attempt } = useAction();
  const set = (p: Partial<KbInput>) => setV((x) => ({ ...x, ...p }));
  const candidates = data.items.filter((i) => i.key !== v.key && matches(i, refQ)).slice(0, 30);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial) || tags !== initial.tags.join(', ');
  return (
    <Dialog
      title={v.key ? t('kb.edit') : t('kb.newTitle')}
      onClose={onClose}
      width="lg"
      dirty={dirty}
      onSubmit={async () => {
        const m = { title: !v.title.trim(), topic: !v.topicId };
        setMissing(m);
        if (m.title) titleRef.current?.focus();
        if (m.title || m.topic) return;
        let key = '';
        const ok = await attempt(async () => {
          key = await api.kbSave({
            ...v,
            title: v.title.trim(),
            tags: tags
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          });
        });
        if (ok) onSaved(key);
      }}
    >
      <Field
        label={t('kb.field.title')}
        required
        error={missing.title && !v.title.trim() ? t('field.required') : null}
      >
        <TextInput
          ref={titleRef}
          autoFocus
          maxLength={200}
          value={v.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <TopicPicker data={data} topicId={v.topicId} onChange={(topicId) => set({ topicId })} />
      {missing.topic && !v.topicId && (
        <p role="alert" className="-mt-2 text-xs text-danger">
          {t('kb.topic.required')}
        </p>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <span className="flex items-center justify-between text-xs text-muted">
          {t('kb.field.body')}
          <LinkButton onClick={() => setPreview((p) => !p)}>
            {preview ? t('kb.field.write') : t('kb.field.preview')}
          </LinkButton>
        </span>
        {preview ? (
          <div className="prose-hills min-h-32 rounded-control border border-line p-3 text-sm">
            <Markdown skipHtml components={{ img: () => null }}>
              {v.body}
            </Markdown>
          </div>
        ) : (
          <TextArea
            rows={7}
            value={v.body}
            aria-label={t('kb.field.body')}
            onChange={(e) => set({ body: e.target.value })}
          />
        )}
      </div>
      <Field label={t('kb.field.tags')}>
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs text-muted">
          {t('kb.field.refs')} · {v.refs.length}
        </legend>
        <TextInput
          type="search"
          value={refQ}
          placeholder={t('kb.search')}
          aria-label={t('kb.field.refs')}
          onChange={(e) => setRefQ(e.target.value)}
        />
        <ul className="scroll-panel max-h-32 rounded-control border border-line p-1">
          {candidates.map((i) => (
            <li key={i.key}>
              <label className="flex items-center gap-2 px-1 py-0.5">
                <Checkbox
                  checked={v.refs.includes(i.key)}
                  onChange={(e) =>
                    set({
                      refs: e.target.checked
                        ? [...v.refs, i.key]
                        : v.refs.filter((r) => r !== i.key),
                    })
                  }
                />
                <span className="truncate">{i.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy}>
          {t('kb.save')}
        </Button>
      </div>
    </Dialog>
  );
}

// ── 閱讀 ─────────────────────────────────────────────────────

function KbReader({
  item,
  data,
  nameOf,
  canEdit,
  convs,
  onClose,
  onEdit,
  onOpenItem,
  onOpenConv,
  onDeleted,
}: {
  item: KbItem | null;
  data: KbSnapshot;
  nameOf: (id: string) => string;
  canEdit: (i: KbItem) => boolean;
  convs: ConvRow[];
  onClose: () => void;
  onEdit: (i: KbItem) => void;
  onOpenItem: (k: string) => void;
  onOpenConv: (conv: string) => void;
  onDeleted: () => void;
}) {
  const { error, attempt } = useAction();
  if (!item) return null;
  const rels = relations(item, data.items, data.topics);
  const src = item.source;
  const convId = src.kind === 'message' || src.kind === 'file' ? src.convId : null;
  const inConv = convId ? convs.some((c) => c.id === convId) : false;
  return (
    <Dialog label={item.title} onClose={onClose} width="lg">
      <div className="flex flex-col gap-3">
        <span className="text-xs text-muted">{pathOf(item, data)}</span>
        <h2 className="text-xl font-bold">{item.title}</h2>
        <span className="text-xs text-muted">
          {t('kb.byline', { name: nameOf(item.author), time: formatTime(item.updatedAt) })}
          {item.tags.length > 0 && ` · ${item.tags.map((x) => `#${x}`).join(' ')}`}
        </span>
        <div className="prose-hills text-sm break-words">
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
            {item.body || t('kb.noBody')}
          </Markdown>
        </div>
        <div className="text-xs text-muted">
          {t(`kb.source.${src.kind}` as MessageKey)}
          {convId &&
            (inConv ? (
              <LinkButton
                className="ml-2 underline"
                onClick={() => {
                  onClose();
                  onOpenConv(convId);
                }}
              >
                {t('kb.source.openConv')}
              </LinkButton>
            ) : (
              <span className="ml-2">{t('kb.source.notMember')}</span>
            ))}
        </div>
        {rels.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-bold">{t('kb.relCount', { count: rels.length })}</span>
            <ul className="flex flex-wrap gap-2">
              {rels.map((r) => (
                <li key={r.key}>
                  <Chip
                    onClick={() => onOpenItem(r.key)}
                    style={{ borderColor: REL_COLOR[r.kind] }}
                  >
                    {relName(r.kind)} · {data.items.find((i) => i.key === r.key)?.title}
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorText message={error} />
        <div className="flex items-center justify-end gap-2">
          {canEdit(item) && (
            <>
              <ConfirmButton
                label={t('kb.delete')}
                message={t('kb.delete.confirm', { title: item.title })}
                onConfirm={async () => {
                  if (await attempt(() => api.kbDelete(item.key))) onDeleted();
                }}
              />
              <Button variant="secondary" onClick={() => onEdit(item)}>
                {t('kb.edit')}
              </Button>
            </>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── 從對話存成知識（訊息快速動作、附件卡） ─────────────────────

/** 「存成知識」表單：訊息或其附件。送出前提示內容會公開給全組織（ui-spec「知識庫」v0.13）。 */
export function SaveToKb({
  conv,
  messageKey,
  defaultTitle,
  attachment = null,
  onDone,
}: {
  conv: string;
  messageKey: string;
  defaultTitle: string;
  attachment?: number | null;
  onDone: () => void;
}) {
  const kb = useLoad(api.kb, ['doc']);
  const [title, setTitle] = useState(defaultTitle);
  const [topic, setTopic] = useState('');
  const { busy, error, attempt } = useAction();
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || !kb.data) return;
    inited.current = true;
    setTopic(activeTopics(kb.data.topics)[0]?.id ?? '');
  }, [kb.data]);
  return (
    <form
      className="flex w-96 flex-col gap-2 rounded-card bg-surface p-3 text-sm shadow-lg"
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (await attempt(() => api.kbFromMessage(conv, messageKey, topic, title, attachment)))
          onDone();
      }}
    >
      <span className="font-bold">{t('kb.save.title')}</span>
      <Field label={t('kb.field.title')}>
        <TextInput
          size="sm"
          autoFocus
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      {kb.data && <TopicPicker data={kb.data} topicId={topic} onChange={setTopic} />}
      <p role="note" className="rounded-control bg-bg px-2 py-1.5 text-xs text-warning">
        {attachment !== null ? t('kb.save.fileWarning') : t('kb.save.messageWarning')}
      </p>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" className="h-8 px-3 py-0" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="h-8 px-3 py-0" disabled={busy || !topic || !title.trim()}>
          {t('kb.save.submit')}
        </Button>
      </div>
    </form>
  );
}
