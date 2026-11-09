/** 應用外框、團隊、狀態選單、設定（ui-spec「應用外框」「團隊」「設定」，D40）。 */
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  api,
  PRESENCE_STATES,
  type AppInfo,
  type Code,
  type JoinRequestView,
  type Look,
  type MemberView,
  type OfficeView,
  type Overview,
  type PresenceState,
  type SyncStatus,
} from './api';
import { Chat } from './chat';
import { Portrait, StatusBadge, stateLabel } from './figures';
import { DirectionsCard, DriftRulesCard } from './directions-settings';
import { McpConfirmStack } from './mcp-confirm';
import { McpOrgCard, McpPersonalCard } from './mcp-settings';
import { TeamsCard } from './teams-settings';
import { useDirectionPublisher } from './drift-publisher';
import { Goals } from './goals';
import { Home } from './home';
import { Knowledge } from './kb';
import { Reports, useWeeklyReportReminder } from './reports';
import { Scrum, useScrumReminder } from './scrum';
import { useIdleAway, useLoad, useSyncStatus } from './hooks';
import {
  formatClock,
  formatDate,
  formatTime,
  getLocale,
  LOCALES,
  setLocale,
  t,
  type MessageKey,
} from './i18n';
import {
  CommandButton,
  CommandPalette,
  HeadContext,
  PageHead,
  useCommandShortcut,
  type Command,
  type HeadSlots,
} from './layout';
import { BackupForm } from './onboarding';
import { LOOK_PALETTE, lookOf } from './summit';
import { Tasks } from './tasks';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CodeBox,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  Popover,
  Pressable,
  Select,
  Tabs,
  TextInput,
  useAction,
} from './ui';

type Page = 'home' | 'goals' | 'team' | 'tasks' | 'scrum' | 'reports' | 'chat' | 'kb' | 'settings';

const SYNC_ICON: Record<SyncStatus, string> = {
  Synced: '●',
  Syncing: '◐',
  Offline: '○',
  Pending: '○',
};

export function SyncIndicator() {
  const status = useSyncStatus();
  if (!status) return null;
  return (
    <Pressable
      className="flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-sm text-muted shadow-sm hover:text-fg"
      onClick={() => void api.syncNow().catch(() => undefined)}
      aria-live="polite"
    >
      <span aria-hidden className={status === 'Synced' ? 'text-st-online' : ''}>
        {SYNC_ICON[status]}
      </span>
      {t(`sync.${status}` as MessageKey)}
    </Pressable>
  );
}

const NAV_ICON: Record<Page, string> = {
  home: 'M3 9.5L10 3.5l7 6V17H3zM8 17v-5h4v5',
  goals: 'M3 17h4v-4h4V9h4V5h2M3 17v-1',
  team: 'M7 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M2 16c.8-3 3-4.5 5-4.5s4.2 1.5 5 4.5M14 8m-2.4 0a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0M12 15.5c.5-2 1.7-3 3-3s2.6 1 3 3',
  tasks: 'M4 5h2M4 10h2M4 15h2M9 5h7M9 10h7M9 15h7',
  scrum: 'M4 3.5h12v13H4zM7 7.5l1.5 1.5L11 6.5M7 12.5h6',
  reports: 'M5 2.5h7l3 3v12H5zM12 2.5v3h3M7.5 10h5M7.5 13h5M7.5 7h2',
  chat: 'M3 4.5h14v9H8l-4 3v-3H3z',
  kb: 'M10 2.5l2 4.6 5 .5-3.8 3.3 1.1 4.9L10 13.3l-4.3 2.5 1.1-4.9L3 7.6l5-.5z',
  settings:
    'M10 7a3 3 0 1 0 0 6a3 3 0 1 0 0 -6M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
};

const PAGE_TITLE: Record<Page, MessageKey> = {
  home: 'nav.home',
  goals: 'nav.goals',
  team: 'team.title',
  tasks: 'nav.tasks',
  scrum: 'nav.scrum',
  reports: 'nav.reports',
  chat: 'chat.title',
  kb: 'nav.kb',
  settings: 'settings.title',
};

/** 導覽列順序（D43）。 */
const NAV: Page[] = [
  'home',
  'goals',
  'tasks',
  'scrum',
  'reports',
  'chat',
  'kb',
  'team',
  'settings',
];

const noJoins = () => Promise.resolve<JoinRequestView[]>([]);

export function Shell({ info }: { info: AppInfo }) {
  const [page, setPage] = useState<Page>('home');
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [slots, setSlots] = useState<HeadSlots>({ title: null, actions: null });
  const titleRef = useCallback((el: HTMLDivElement | null) => {
    setSlots((s) => (s.title === el ? s : { ...s, title: el }));
  }, []);
  const actionsRef = useCallback((el: HTMLDivElement | null) => {
    setSlots((s) => (s.actions === el ? s : { ...s, actions: el }));
  }, []);
  const overview = useLoad(api.overview, ['org', 'roster', 'presence', 'doc']);
  const tasks = useLoad(api.tasks, ['doc', 'org', 'roster']);
  const focus = useLoad(api.focus, ['doc', 'org', 'roster']);
  const me = overview.data?.members.find((m) => m.isMe);
  useIdleAway(() => (me ? { state: me.presence ?? 'Online', note: me.note } : null));
  const convs = useLoad(api.conversations, ['convs', 'message', 'doc']);
  const unread = (convs.data ?? []).reduce((n, c) => n + c.unread, 0);
  // 管理者：待核准的加入與還原申請數（設定徽章，ui-spec「設定」D41 補充）
  const joins = useLoad(info.isAdmin ? api.pendingJoins : noJoins, ['joins', 'roster']);
  const pendingJoins = joins.data?.length ?? 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // 倒數與回來時間每 30 秒更新
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useCommandShortcut(() => setPalette(true));
  useScrumReminder(overview.data?.timezone ?? null);
  useWeeklyReportReminder(overview.data?.timezone ?? null);
  useDirectionPublisher(me?.id ?? null, tasks.data, overview.data?.timezone ?? '');
  const go = (p: Page) => {
    setPage(p);
    if (p !== 'chat') setOpenConv(null);
  };
  const openChat = (conv: string) => {
    setOpenConv(conv);
    setPage('chat');
  };
  const orgName = overview.data?.orgName ?? info.orgName ?? '';
  const commands: Command[] = [
    ...NAV.map((p) => ({
      id: `page:${p}`,
      label: t(PAGE_TITLE[p]),
      group: 'cmd.group.pages' as const,
      run: () => go(p),
    })),
    ...(overview.data?.members ?? [])
      .filter((m) => !m.isMe)
      .map((m) => ({
        id: `member:${m.id}`,
        label: t('cmd.message', { name: m.name }),
        keywords: m.name,
        group: 'cmd.group.people' as const,
        member: m,
        run: () => void api.openDm(m.id).then(openChat, () => undefined),
      })),
  ];
  return (
    <HeadContext.Provider value={slots}>
      <div className="flex h-full overflow-hidden bg-bg">
        <nav
          aria-label={t('nav.label')}
          className="flex w-19 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3 wide:w-22 wide:gap-2 wide:py-4"
        >
          <span
            className="mb-2 flex size-10 items-center justify-center rounded-control bg-primary font-bold text-on-primary"
            title={orgName}
            aria-label={orgName || t('app.name')}
          >
            {(orgName || 'H').slice(0, 1)}
          </span>
          {NAV.map((p) => {
            const active = page === p;
            const badge = p === 'settings' ? pendingJoins : p === 'chat' ? unread : 0;
            return (
              <Pressable
                key={p}
                aria-current={active ? 'page' : undefined}
                onClick={() => go(p)}
                className={`relative flex w-15 flex-col items-center gap-0.5 rounded-control py-1.5 text-xs wide:w-18 wide:py-2 ${active ? 'bg-primary-soft font-bold text-primary' : 'text-muted hover:text-fg'}`}
              >
                <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden>
                  <path
                    d={NAV_ICON[p]}
                    stroke="currentColor"
                    strokeWidth={1.6}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t(PAGE_TITLE[p])}
                {badge > 0 && (
                  <Badge
                    tone="alert"
                    className="absolute top-0.5 right-1.5 min-w-4.5 justify-center"
                    label={
                      p === 'chat'
                        ? t('chat.unread', { count: badge })
                        : t('joins.badge', { count: badge })
                    }
                  >
                    {badge}
                  </Badge>
                )}
              </Pressable>
            );
          })}
          {me && overview.data && <StatusMenu me={me} overview={overview.data} />}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-13 shrink-0 items-center gap-3 px-4 wide:h-15 wide:px-6">
            <div ref={titleRef} className="flex min-w-0 flex-1" />
            <div ref={actionsRef} className="flex shrink-0 items-center gap-2" />
            <CommandButton onOpen={() => setPalette(true)} />
            <SyncIndicator />
          </header>
          <main className="min-h-0 flex-1 px-4 pb-4 wide:px-6 wide:pb-6">
            {page !== 'home' &&
              page !== 'goals' &&
              page !== 'kb' &&
              page !== 'scrum' &&
              page !== 'reports' && (
                <PageHead
                  title={t(PAGE_TITLE[page])}
                  subtitle={page === 'tasks' ? undefined : orgName}
                />
              )}
            {overview.error && <ErrorText message={overview.error} />}
            {page === 'home' && overview.data && (
              <Home
                overview={overview.data}
                tasks={tasks.data ?? []}
                focus={focus.data}
                convs={convs.data ?? []}
                onOpenConv={openChat}
                onOpenTasks={() => go('tasks')}
                now={now}
              />
            )}
            {page === 'goals' && overview.data && (
              <Goals
                members={overview.data.members}
                teams={overview.data.teams}
                tasks={tasks.data ?? []}
                focusId={focus.data?.task?.id ?? null}
                timezone={overview.data.timezone}
              />
            )}
            {page === 'scrum' && overview.data && (
              <Scrum
                members={overview.data.members}
                teams={overview.data.teams}
                tasks={tasks.data ?? []}
                focusId={focus.data?.task?.id ?? null}
                timezone={overview.data.timezone}
              />
            )}
            {page === 'reports' && overview.data && (
              <Reports
                members={overview.data.members}
                teams={overview.data.teams}
                tasks={tasks.data ?? []}
                timezone={overview.data.timezone}
              />
            )}
            {page === 'kb' && overview.data && (
              <Knowledge
                members={overview.data.members}
                isAdmin={info.isAdmin}
                timezone={overview.data.timezone}
                onOpenConv={openChat}
              />
            )}
            {page === 'team' && overview.data && (
              <div className="scroll-panel h-full">
                <TeamList overview={overview.data} />
              </div>
            )}
            {page === 'tasks' && (
              <div className="scroll-panel h-full">
                <Tasks
                  tasks={tasks.data ?? []}
                  teams={overview.data?.teams ?? []}
                  members={overview.data?.members ?? []}
                  focus={focus.data}
                  timezone={overview.data?.timezone ?? ''}
                  error={tasks.error}
                  isAdmin={info.isAdmin}
                  loading={tasks.data === null && !tasks.error}
                />
              </div>
            )}
            {page === 'chat' && (
              <Chat
                key={openConv ?? ''}
                members={overview.data?.members ?? []}
                tasks={tasks.data ?? []}
                teams={overview.data?.teams ?? []}
                initial={openConv}
              />
            )}
            {page === 'settings' && (
              <div className="scroll-panel h-full">
                <Settings
                  info={info}
                  members={overview.data?.members ?? []}
                  orgName={overview.data?.orgName ?? ''}
                  overview={overview.data}
                />
              </div>
            )}
          </main>
        </div>
        {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
        <McpConfirmStack members={overview.data?.members ?? []} />
      </div>
    </HeadContext.Provider>
  );
}

// ── 狀態選單（ui-spec「設定」M1 補充） ───────────────────────

const UNTIL_PRESETS = [15, 30, 60] as const;

function inLunch(lunch: Overview['lunchBreak'], now: Date): boolean {
  if (!lunch) return false;
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return hm >= lunch.start && hm < lunch.end;
}

function todayAt(hm: string, now = new Date()): number {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function locationLabel(code: string, offices: OfficeView[]): string {
  if (code === 'remote') return t('location.remote');
  const o = offices.find((x) => `office:${x.id}` === code);
  return o ? o.name : t('location.hidden');
}

function StatusMenu({ me, overview }: { me: MemberView; overview: Overview }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative mt-auto flex flex-col items-center">
      <Pressable
        ref={btn}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex flex-col items-center gap-1 rounded-control px-2 py-1 hover:bg-bg"
      >
        <Portrait look={lookOf(me)} state={me.presence} size={52} label={t('status.menu')} />
        <StatusBadge state={me.presence} />
      </Pressable>
      {open && (
        <StatusPanel
          key={`${me.presence}-${me.until}-${me.location}-${me.note}`}
          me={me}
          overview={overview}
          anchorRef={btn}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function StatusPanel({
  me,
  overview,
  onClose,
  anchorRef,
}: {
  me: MemberView;
  overview: Overview;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<PresenceState>(me.presence ?? 'Online');
  const [until, setUntil] = useState<number | null>(me.until);
  const [location, setLocation] = useState(me.location);
  const [note, setNote] = useState(me.note);
  const { busy, error, attempt } = useAction();
  const ids = { state: useId(), loc: useId(), until: useId() };
  const lunch = overview.lunchBreak;
  const save = async (s = state, u = until) => {
    if (await attempt(() => api.setPresenceFull(s, note, u, location))) onClose();
  };
  return (
    <Popover
      label={t('status.menu')}
      onClose={onClose}
      anchorRef={anchorRef}
      className="absolute bottom-0 left-full ml-3 flex w-80 flex-col gap-3 p-4"
    >
      {lunch && inLunch(lunch, new Date()) && state !== 'Lunch' && (
        <Button
          variant="soft"
          disabled={busy}
          onClick={() => void save('Lunch', todayAt(lunch.end))}
        >
          {t('status.lunchNow', { end: lunch.end })}
        </Button>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.state} className="text-sm font-medium">
          {t('team.myStatus')}
        </label>
        <Select
          id={ids.state}
          className="w-full"
          value={state}
          onChange={(e) => setState(e.target.value as PresenceState)}
        >
          {PRESENCE_STATES.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span id={ids.until} className="text-sm font-medium">
          {t('status.until')}
        </span>
        <div role="group" aria-labelledby={ids.until} className="flex flex-wrap gap-1">
          <Button
            variant={until === null ? 'soft' : 'secondary'}
            size="sm"
            onClick={() => setUntil(null)}
          >
            {t('status.until.none')}
          </Button>
          {UNTIL_PRESETS.map((m) => (
            <Button
              key={m}
              variant="secondary"
              size="sm"
              onClick={() => setUntil(Date.now() + m * 60_000)}
            >
              {t('time.minutes', { m })}
            </Button>
          ))}
          <TextInput
            size="sm"
            type="time"
            aria-label={t('status.until.at')}
            value={until ? formatClock(until).slice(-5) : ''}
            onChange={(e) => {
              if (!e.target.value) return;
              let ms = todayAt(e.target.value);
              if (ms < Date.now()) ms += 86_400_000;
              setUntil(ms);
            }}
          />
        </div>
        {until && (
          <p className="text-xs text-muted">
            {state === 'Leave'
              ? t('home.leaveUntil', { date: formatDate(until) })
              : t('home.until', { time: formatClock(until) })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.loc} className="text-sm font-medium">
          {t('status.location')}
        </label>
        <Select
          id={ids.loc}
          className="w-full"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        >
          {overview.offices.map((o) => (
            <option key={o.id} value={`office:${o.id}`}>
              {o.name}
            </option>
          ))}
          <option value="remote">{t('location.remote')}</option>
          <option value="hidden">{t('location.hidden')}</option>
        </Select>
      </div>
      <Field
        label={t('team.note')}
        placeholder={t('team.note.placeholder')}
        value={note}
        onChange={setNote}
      />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {t('team.update')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
      <ErrorText message={error} />
    </Popover>
  );
}

// ── 團隊（首頁山景的清單檢視） ─────────────────────────────

function TeamList({ overview }: { overview: Overview }) {
  const { members, teams, offices } = overview;
  const online = members.filter((m) => m.presence && m.presence !== 'Offline').length;
  const byId = new Map(members.map((m) => [m.id, m]));
  const grouped = teams.map((tm) => ({
    ...tm,
    list: tm.members.map((id) => byId.get(id)).filter((m): m is MemberView => Boolean(m)),
  }));
  const inTeam = new Set(teams.flatMap((tm) => tm.members));
  const loose = members.filter((m) => !inTeam.has(m.id));
  if (loose.length)
    grouped.push({ id: '', name: t('team.noTeam'), members: [], leads: [], list: loose });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('team.summary', { online, total: members.length })}</p>
      {members.length <= 1 && <EmptyState art="team">{t('team.empty')}</EmptyState>}
      {grouped.map((g) => (
        <Card key={g.id || 'none'}>
          <h2 className="mb-3 font-bold">{g.name}</h2>
          <ul className="flex flex-col divide-y divide-line">
            {g.list.map((m) => (
              <li
                key={m.id}
                className="grid grid-cols-[3rem_10rem_7rem_14rem_1fr] items-center gap-3 py-2"
              >
                <Portrait look={lookOf(m)} state={m.presence} size={40} label={m.name} />
                <span className="truncate font-semibold">
                  {m.name}
                  {m.isMe && <span className="text-muted">{t('team.me')}</span>}
                  {m.isAdmin && <Badge className="ml-2 font-normal">{t('team.admin')}</Badge>}
                </span>
                <StatusBadge state={m.presence} />
                <span className="truncate text-sm text-muted">
                  {locationLabel(m.location, offices)}
                  {m.until &&
                    ` · ${m.presence === 'Leave' ? t('home.leaveUntil', { date: formatDate(m.until) }) : t('home.until', { time: formatClock(m.until) })}`}
                </span>
                <span className="truncate text-sm text-muted">{m.note}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ── 我的角色（設定 → 個人） ──────────────────────────────

function MyLook({ me }: { me: MemberView }) {
  const [look, setLook] = useState<Look>(lookOf(me));
  const [saved, setSaved] = useState(false);
  const { busy, error, attempt } = useAction();
  const parts: { key: keyof Look; label: MessageKey; token: string; count: number }[] = [
    { key: 'hair', label: 'look.hair', token: 'hair', count: LOOK_PALETTE },
    { key: 'shirt', label: 'look.shirt', token: 'shirt', count: LOOK_PALETTE },
    { key: 'skin', label: 'look.skin', token: 'skin', count: LOOK_PALETTE },
  ];
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-bold">{t('look.title')}</h2>
      <div className="flex flex-wrap items-center gap-6">
        <Portrait
          look={look}
          state={me.presence ?? 'Online'}
          size={110}
          label={t('look.preview')}
        />
        <div className="flex flex-col gap-3">
          {parts.map((p) => (
            <div
              key={p.key}
              role="radiogroup"
              aria-label={t(p.label)}
              className="flex items-center gap-2"
            >
              <span className="w-12 text-sm font-medium">{t(p.label)}</span>
              {Array.from({ length: p.count }, (_, i) => (
                <Pressable
                  key={i}
                  role="radio"
                  aria-checked={look[p.key] === i}
                  aria-label={t('look.option', { n: i + 1 })}
                  onClick={() => {
                    setLook({ ...look, [p.key]: i });
                    setSaved(false);
                  }}
                  className={`size-7 rounded-full border-2 ${look[p.key] === i ? 'border-primary' : 'border-line'}`}
                  style={{ background: `var(--hills-${p.token}-${i})` }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button
          disabled={busy}
          onClick={async () => {
            if (await attempt(() => api.setProfile(look))) setSaved(true);
          }}
        >
          {t('common.save')}
        </Button>
        {saved && (
          <span role="status" className="text-sm text-st-online-text">
            {t('look.saved')}
          </span>
        )}
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

// ── 辦公室與午休（設定 → 組織，管理者） ──────────────────────

function OfficesCard({ overview }: { overview: Overview }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState(overview.lunchBreak?.start ?? '12:00');
  const [end, setEnd] = useState(overview.lunchBreak?.end ?? '13:30');
  const { busy, error, attempt } = useAction();
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-bold">{t('offices.title')}</h2>
      <p className="text-sm text-muted">{t('offices.desc')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {overview.offices.map((o) => (
          <OfficeRow key={o.id} office={o} />
        ))}
        {overview.offices.length === 0 && (
          <li className="py-2 text-sm text-muted">{t('offices.empty')}</li>
        )}
      </ul>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field
            label={t('offices.new')}
            value={name}
            onChange={setName}
            placeholder={t('offices.new.placeholder')}
          />
        </div>
        <Button
          variant="soft"
          disabled={busy || !name.trim()}
          onClick={async () => {
            if (await attempt(() => api.upsertOffice(null, name))) setName('');
          }}
        >
          {t('offices.add')}
        </Button>
      </div>
      <h3 className="mt-2 font-bold">{t('lunch.title')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('lunch.start')}
          <TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('lunch.end')}
          <TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button
          variant="soft"
          disabled={busy}
          onClick={() => void attempt(() => api.setLunchBreak(start, end))}
        >
          {t('common.save')}
        </Button>
        {overview.lunchBreak && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void attempt(() => api.setLunchBreak('', ''))}
          >
            {t('lunch.clear')}
          </Button>
        )}
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

function OfficeRow({ office }: { office: OfficeView }) {
  const [name, setName] = useState(office.name);
  const { busy, error, attempt } = useAction();
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <TextInput
        aria-label={t('offices.name')}
        className="min-w-40 flex-1"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !name.trim() || name === office.name}
        onClick={() => void attempt(() => api.upsertOffice(office.id, name))}
      >
        {t('offices.rename')}
      </Button>
      <ConfirmButton
        label={t('offices.remove')}
        message={t('offices.remove.confirm', { name: office.name })}
        onConfirm={async () => {
          await attempt(() => api.removeOffice(office.id));
        }}
      />
      <ErrorText message={error} />
    </li>
  );
}

type Tab = 'personal' | 'org' | 'members';

function Settings({
  info,
  members,
  orgName,
  overview,
}: {
  info: AppInfo;
  members: MemberView[];
  orgName: string;
  overview: Overview | null;
}) {
  const [tab, setTab] = useState<Tab>('personal');
  const tabs: [Tab, MessageKey][] = [
    ['personal', 'settings.tab.personal'],
    ['org', 'settings.tab.org'],
    ['members', 'settings.tab.members'],
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Tabs
        label={t('nav.settings')}
        value={tab}
        onChange={setTab}
        options={tabs.map(([k, label]) => ({ value: k, label: t(label) }))}
      />
      {tab === 'personal' && <PersonalTab me={members.find((m) => m.isMe)} />}
      {tab === 'org' && <OrgTab info={info} orgName={orgName} overview={overview} />}
      {tab === 'members' && <MembersTab info={info} members={members} overview={overview} />}
    </div>
  );
}

/** 版本號與建置 commit（ui-spec「設定 → 個人」v0.30），回報問題時附上。 */
function VersionCard() {
  const v = useLoad(api.appVersion, []);
  if (!v.data) return null;
  const text = v.data.commit ? `${v.data.version} (${v.data.commit})` : v.data.version;
  return (
    <Card className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium">{t('settings.version')}</span>
      <code className="text-sm text-muted select-all">{text}</code>
    </Card>
  );
}

function PersonalTab({ me }: { me: MemberView | undefined }) {
  const devices = useLoad(api.devices, ['roster', 'device-added']);
  const account = useLoad(api.cafecaAccount, ['org']);
  const { error, attempt } = useAction();
  return (
    <>
      {me && <MyLook me={me} />}
      <Card className="flex items-center justify-between gap-3">
        <label htmlFor="lang" className="text-sm font-medium">
          {t('settings.language')}
        </label>
        <Select
          id="lang"
          value={getLocale()}
          onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`lang.${l}` as MessageKey)}
            </option>
          ))}
        </Select>
      </Card>
      <ScrumReminderCard />
      <McpPersonalCard />
      <VersionCard />
      {account.data && (
        <Card className="flex flex-col gap-2">
          <h2 className="font-medium">{t('settings.cafeca')}</h2>
          {account.data.handle && <p className="text-sm">@{account.data.handle}</p>}
          <code className="break-all text-xs text-muted select-all">{account.data.address}</code>
          <p className="text-xs text-muted">{t('settings.cafeca.desc')}</p>
        </Card>
      )}
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">{t('settings.devices')}</h2>
        <p className="text-sm text-muted">{t('settings.devices.add')}</p>
        <ul className="flex flex-col divide-y divide-line">
          {(devices.data ?? []).map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {d.name}
                {d.thisDevice && (
                  <span className="ml-2 text-xs text-muted">{t('settings.thisDevice')}</span>
                )}
                <span className="block text-xs text-muted">{formatTime(d.issuedAt)}</span>
              </span>
              {!d.thisDevice && (
                <ConfirmButton
                  label={t('settings.revokeDevice')}
                  message={t('settings.revokeDevice.confirm', { name: d.name })}
                  onConfirm={async () => {
                    if (await attempt(() => api.revokeDevice(d.id))) devices.reload();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        <ErrorText message={error ?? devices.error ?? account.error} />
      </Card>
    </>
  );
}

/** 設定 › 個人「Scrum 提醒時間」（只存本機，technical-design §16.12）。 */
function ScrumReminderCard() {
  const r = useLoad(api.scrumReminder, ['org']);
  const [value, setValue] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const current = value ?? r.data?.mine ?? '';
  return (
    <Card className="flex flex-col gap-2">
      <label htmlFor="scrum-reminder" className="text-sm font-medium">
        {t('settings.scrumReminder')}
      </label>
      <div className="flex items-center gap-2">
        <TextInput
          id="scrum-reminder"
          type="time"
          value={current}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={busy || value === null}
          onClick={async () => {
            if (await attempt(() => api.setMyScrumReminder(current || null))) {
              setValue(null);
              r.reload();
            }
          }}
        >
          {t('common.save')}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {t('settings.scrumReminder.hint', { time: r.data?.org ?? '17:30' })}
      </p>
      <ErrorText message={error ?? r.error} />
    </Card>
  );
}

/** 設定 › 組織「Scrum 預設提醒時間」（管理者）。 */
function OrgScrumReminderCard() {
  const r = useLoad(api.scrumReminder, ['org']);
  const [value, setValue] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const current = value ?? r.data?.org ?? '17:30';
  return (
    <Card className="flex flex-col gap-2">
      <label htmlFor="org-scrum-reminder" className="text-sm font-medium">
        {t('settings.orgScrumReminder')}
      </label>
      <div className="flex items-center gap-2">
        <TextInput
          id="org-scrum-reminder"
          type="time"
          required
          value={current}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={busy || value === null || !current}
          onClick={async () => {
            if (await attempt(() => api.setOrgScrumReminder(current))) setValue(null);
          }}
        >
          {t('common.save')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('settings.orgScrumReminder.hint')}</p>
      <ErrorText message={error ?? r.error} />
    </Card>
  );
}

function OrgTab({
  info,
  orgName,
  overview,
}: {
  info: AppInfo;
  orgName: string;
  overview: Overview | null;
}) {
  const [name, setName] = useState(orgName);
  const [code, setCode] = useState<Code | null>(null);
  const { busy, error, run, attempt } = useAction();
  return (
    <>
      <Card className="flex flex-col gap-3">
        <Field label={t('settings.orgName')} value={name} onChange={setName} />
        {info.isAdmin && (
          <div>
            <Button
              disabled={busy || !name.trim() || name === orgName}
              onClick={() => void attempt(() => api.renameOrg(name))}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">{t('settings.orgCode')}</h2>
        <p className="text-sm text-muted">{t('settings.orgCode.desc')}</p>
        {code ? (
          <CodeBox code={code.code} qrSvg={code.qrSvg} />
        ) : (
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                const c = await run(api.orgCode);
                if (c) setCode(c);
              }}
            >
              {t('settings.show')}
            </Button>
          </div>
        )}
      </Card>
      {info.isAdmin && overview && <OfficesCard overview={overview} />}
      {info.isAdmin && <OrgScrumReminderCard />}
      {info.isAdmin && <DirectionsCard />}
      {info.isAdmin && <DriftRulesCard />}
      {info.isAdmin && <McpOrgCard />}
      {info.hasOrgRoot && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">{t('settings.backup')}</h2>
          <BackupForm />
        </Card>
      )}
      <ErrorText message={error} />
    </>
  );
}

function MembersTab({
  info,
  members,
  overview,
}: {
  info: AppInfo;
  members: MemberView[];
  overview: Overview | null;
}) {
  const joins = useLoad(api.pendingJoins, ['joins', 'roster']);
  const { error, attempt } = useAction();
  const leads = overview?.teams.some((tm) => tm.leads.includes(info.memberId ?? '')) ?? false;
  if (!info.isAdmin) {
    // 不是管理者的負責人只看到自己負責的小組（D49）
    return leads ? (
      <TeamsCard members={members} isAdmin={false} />
    ) : (
      <p className="text-sm text-muted">{t('members.adminOnly')}</p>
    );
  }
  return (
    <>
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">{t('joins.title')}</h2>
        <p className="text-sm text-muted">{t('joins.desc')}</p>
        {(joins.data ?? []).length === 0 && (
          <EmptyState art="team" loading={joins.data === null}>
            {t('joins.empty')}
          </EmptyState>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {(joins.data ?? []).map((j) => (
            <JoinRow key={j.device} join={j} overview={overview} onDone={joins.reload} />
          ))}
        </ul>
        <ErrorText message={joins.error} />
      </Card>
      <TeamsCard members={members} isAdmin />
      <Card className="flex flex-col gap-2">
        <h2 className="font-medium">{t('members.title')}</h2>
        <ul className="flex flex-col divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {m.name}
                {m.isMe && <span className="text-muted">{t('team.me')}</span>}
                {m.isAdmin && (
                  <span className="ml-2 rounded-control border border-line px-1 text-xs text-muted">
                    {t('team.admin')}
                  </span>
                )}
              </span>
              {!m.isMe && (
                <ConfirmButton
                  label={t('members.revoke')}
                  message={t('members.revoke.confirm', { name: m.name })}
                  onConfirm={async () => {
                    await attempt(() => api.revokeMember(m.id));
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </Card>
      <ErrorText message={error} />
    </>
  );
}

/** 一筆待核准申請：加入時選擇角色與小組；還原沿用原角色（ui-spec「設定」D41 補充）。 */
function JoinRow({
  join,
  overview,
  onDone,
}: {
  join: JoinRequestView;
  overview: Overview | null;
  onDone: () => void;
}) {
  const [admin, setAdmin] = useState(false);
  const teams = overview?.teams ?? [];
  const [team, setTeam] = useState<string>('');
  const { busy, error, attempt } = useAction();
  const recover = join.kind === 'recover';
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {t(recover ? 'joins.kind.recover' : 'joins.kind.join')} ·{' '}
          {join.handle ? `@${join.handle}` : join.accountShort}
        </span>
        <span className="text-xs text-muted">{formatTime(join.receivedAt)}</span>
      </div>
      <span className="text-sm text-muted">
        {t('joins.detail', {
          name: join.name || '—',
          device: join.deviceName,
          account: join.accountShort,
        })}
      </span>
      {recover ? (
        <p className="text-sm">{t('joins.recoverHint')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            {t('joins.asAdmin')}
          </label>
          {teams.length > 0 && (
            <label className="flex items-center gap-2">
              {t('joins.team')}
              <Select size="sm" value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">{t('joins.team.default')}</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            if (await attempt(() => api.approveJoin(join.device, admin, team ? [team] : []))) {
              onDone();
            }
          }}
        >
          {t('joins.approve')}
        </Button>
        <ConfirmButton
          label={t('joins.reject')}
          message={t('joins.reject.confirm')}
          onConfirm={async () => {
            if (await attempt(() => api.rejectJoin(join.device))) onDone();
          }}
        />
      </div>
      <ErrorText message={error} />
    </li>
  );
}
