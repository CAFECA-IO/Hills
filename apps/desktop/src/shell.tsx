/** 應用外框、團隊、狀態選單、設定（ui-spec「應用外框」「團隊」「設定」，D40）。 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AppInfo,
  type JoinRequestView,
  type MemberProfileView,
  type MemberView,
  type Overview,
  type SyncStatus,
} from './api';
import { Chat } from './chat';
import { Avatar, StatusBadge, stateLabel, statusTextClass } from './figures';
import { McpConfirmStack } from './mcp-confirm';
import { readGroup, Settings, writeGroup, type Group } from './settings';
import { locationLabel, StatusMenu } from './status';
import { useDirectionPublisher } from './drift-publisher';
import { Home } from './home';
import { Files } from './files';
import { Knowledge } from './kb';
import { useNavigation } from './nav';
import { readWorkTab, Work, type WorkSub, type WorkTab } from './work';
import { useWeeklyReportReminder } from './reports';
import { useScrumReminder } from './scrum';
import { useIdleAway, useLoad, useSyncStatus } from './hooks';
import { formatClock, formatDate, t, type MessageKey } from './i18n';
import {
  CommandButton,
  CommandPalette,
  HeadContext,
  PageHead,
  useCommandShortcut,
  type Command,
  type HeadSlots,
} from './layout';
import { isOffHours } from './profile-utils';
import { Badge, Card, EmptyState, ErrorText, LinkButton, Pressable, SegmentedControl } from './ui';

interface Jump {
  fromFiles?: boolean;
  highlight?: string;
  task?: string;
  kbItem?: string;
  filesConv?: string;
  filesKey?: string;
}

type Page = 'home' | 'work' | 'team' | 'chat' | 'files' | 'kb' | 'settings';

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
  work: 'M3 17h4v-4h4V9h4V5h2M3 17v-1',
  team: 'M7 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M2 16c.8-3 3-4.5 5-4.5s4.2 1.5 5 4.5M14 8m-2.4 0a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0M12 15.5c.5-2 1.7-3 3-3s2.6 1 3 3',
  chat: 'M3 4.5h14v9H8l-4 3v-3H3z',
  files: 'M3 5.5h5l1.6 1.6H17v8.4H3zM3 8.6h14',
  kb: 'M10 2.5l2 4.6 5 .5-3.8 3.3 1.1 4.9L10 13.3l-4.3 2.5 1.1-4.9L3 7.6l5-.5z',
  settings:
    'M10 7a3 3 0 1 0 0 6a3 3 0 1 0 0 -6M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
};

const PAGE_TITLE: Record<Page, MessageKey> = {
  home: 'nav.home',
  work: 'nav.work',
  team: 'team.title',
  chat: 'chat.title',
  files: 'nav.files',
  kb: 'nav.kb',
  settings: 'settings.title',
};

/** 導覽列順序（D43；D59 目標、任務、Scrum、報表合成「工作」）。 */
const NAV: Page[] = ['home', 'work', 'chat', 'files', 'kb', 'team', 'settings'];

const noJoins = () => Promise.resolve<JoinRequestView[]>([]);

function withOffHours(
  ov: ReturnType<typeof useLoad<Overview>>,
  profiles: MemberProfileView[] | null,
  now: number,
): ReturnType<typeof useLoad<Overview>> {
  if (!ov.data || !profiles) return ov;
  const byId = new Map(profiles.map((p) => [p.member, p]));
  return {
    ...ov,
    data: {
      ...ov.data,
      members: ov.data.members.map((m) =>
        m.isMe ? m : { ...m, offHours: isOffHours(byId.get(m.id), now) },
      ),
    },
  };
}

export function Shell({ info }: { info: AppInfo }) {
  const [page, setPage] = useState<Page>('home');
  const [work, setWork] = useState<{ tab: WorkTab; sub: WorkSub }>(() => ({
    tab: readWorkTab(),
    sub: null,
  }));
  const goWork = (tab: WorkTab, sub: WorkSub = null) => {
    setWork({ tab, sub });
    setPage('work');
    setOpenConv(null);
  };
  const [settingsGroup, setSettingsGroup] = useState<Group>(readGroup);
  const openSettings = (g: Group) => {
    setSettingsGroup(g);
    writeGroup(g);
    setPage('settings');
  };
  const [openConv, setOpenConv] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [slots, setSlots] = useState<HeadSlots>({ title: null, actions: null });
  const titleRef = useCallback((el: HTMLDivElement | null) => {
    setSlots((s) => (s.title === el ? s : { ...s, title: el }));
  }, []);
  const actionsRef = useCallback((el: HTMLDivElement | null) => {
    setSlots((s) => (s.actions === el ? s : { ...s, actions: el }));
  }, []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // 倒數與回來時間每 30 秒更新
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const rawOverview = useLoad(api.overview, ['org', 'roster', 'presence', 'doc']);
  const profiles = useLoad(api.memberProfiles, ['doc', 'roster']);
  const tasks = useLoad(api.tasks, ['doc', 'org', 'roster']);
  const focus = useLoad(api.focus, ['doc', 'org', 'roster']);
  // 同事的非工作時段（D57）：以對方的時區與工作時段計算，每 30 秒隨 now 更新
  const overview = withOffHours(rawOverview, profiles.data, now);
  const me = overview.data?.members.find((m) => m.isMe);
  useIdleAway(() => (me ? { state: me.presence ?? 'Online', note: me.note } : null));
  const convs = useLoad(api.conversations, ['convs', 'message', 'doc']);
  const unread = (convs.data ?? []).reduce((n, c) => n + c.unread, 0);
  // 管理者：待核准的加入與還原申請數（設定徽章，ui-spec「設定」D41 補充）
  const joins = useLoad(info.isAdmin ? api.pendingJoins : noJoins, ['joins', 'roster']);
  const pendingJoins = joins.data?.length ?? 0;
  useCommandShortcut(() => setPalette(true));
  useScrumReminder(overview.data?.timezone ?? null);
  useWeeklyReportReminder(overview.data?.timezone ?? null);
  useDirectionPublisher(me?.id ?? null, tasks.data, overview.data?.timezone ?? '');
  // 跨頁跳轉（D64：前往出處、在檔案中顯示）
  const [jump, setJump] = useState<Jump>({});
  useNavigation((to) => {
    if (to.page === 'files') {
      setJump({ filesConv: to.conv, filesKey: to.fileKey });
      setPage('files');
    } else if (to.page === 'chat') {
      setJump({ fromFiles: to.fromFiles, highlight: to.message });
      setOpenConv(to.conv);
      setPage('chat');
    } else if (to.page === 'task') {
      setJump({ fromFiles: to.fromFiles, task: to.task });
      setWork((w) => ({ ...w, sub: 'tasks' }));
      setPage('work');
    } else {
      setJump({ fromFiles: to.fromFiles, kbItem: to.item });
      setPage('kb');
    }
  });
  const go = (p: Page) => {
    setJump({});
    setPage(p);
    if (p === 'work') setWork((w) => ({ ...w, sub: null }));
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
    ...(['today', 'week', 'goals', 'team'] as const).map((tab) => ({
      id: `work:${tab}`,
      label: `${t('nav.work')} › ${t(`work.tab.${tab}`)}`,
      group: 'cmd.group.pages' as const,
      run: () => goWork(tab),
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
          {me && overview.data && (
            <StatusMenu me={me} overview={overview.data} onOpenLook={() => openSettings('me')} />
          )}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-13 shrink-0 items-center gap-3 px-4 wide:h-15 wide:px-6">
            <div ref={titleRef} className="flex min-w-0 flex-1" />
            <div ref={actionsRef} className="flex shrink-0 items-center gap-2" />
            <CommandButton onOpen={() => setPalette(true)} />
            <SyncIndicator />
          </header>
          <main className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 wide:px-6 wide:pb-6">
            {jump.fromFiles && page !== 'files' && (
              <div
                role="status"
                className="flex shrink-0 items-center gap-3 rounded-control bg-primary-soft px-3 py-1.5 text-sm"
              >
                <LinkButton onClick={() => go('files')}>{t('fpage.back')}</LinkButton>
                <span className="text-xs text-muted">{t('fpage.jumped')}</span>
              </div>
            )}
            <div className="min-h-0 flex-1">
              {page !== 'home' && page !== 'work' && page !== 'kb' && page !== 'files' && (
                <PageHead title={t(PAGE_TITLE[page])} subtitle={orgName} />
              )}
              {overview.error && <ErrorText message={overview.error} />}
              {page === 'home' && overview.data && (
                <Home
                  overview={overview.data}
                  tasks={tasks.data ?? []}
                  focus={focus.data}
                  convs={convs.data ?? []}
                  onOpenConv={openChat}
                  onOpenTasks={() => goWork('today', 'tasks')}
                  now={now}
                />
              )}
              {page === 'work' && overview.data && (
                <Work
                  tab={work.tab}
                  sub={work.sub}
                  onNavigate={(tab, sub) => goWork(tab, sub)}
                  tasks={tasks.data ?? []}
                  tasksError={tasks.error}
                  tasksLoading={tasks.data === null && !tasks.error}
                  members={overview.data.members}
                  teams={overview.data.teams}
                  focus={focus.data}
                  timezone={overview.data.timezone}
                  isAdmin={info.isAdmin}
                  openTask={jump.task ?? null}
                />
              )}
              {page === 'files' && overview.data && (
                <Files
                  key={`${jump.filesConv ?? ''}|${jump.filesKey ?? ''}`}
                  members={overview.data.members}
                  conv={jump.filesConv ?? null}
                  fileKey={jump.filesKey ?? null}
                />
              )}
              {page === 'kb' && overview.data && (
                <Knowledge
                  key={jump.kbItem ?? ''}
                  openItem={jump.kbItem ?? null}
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
              {page === 'chat' && (
                <Chat
                  key={openConv ?? ''}
                  members={overview.data?.members ?? []}
                  tasks={tasks.data ?? []}
                  teams={overview.data?.teams ?? []}
                  offices={overview.data?.offices ?? []}
                  initial={openConv}
                  highlight={jump.highlight ?? null}
                />
              )}
              {page === 'settings' && overview.data && (
                <Settings
                  info={info}
                  overview={overview.data}
                  group={settingsGroup}
                  onGroup={(g) => {
                    setSettingsGroup(g);
                    writeGroup(g);
                  }}
                />
              )}
            </div>
          </main>
        </div>
        {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
        <McpConfirmStack members={overview.data?.members ?? []} />
      </div>
    </HeadContext.Provider>
  );
}

// ── 團隊（首頁山景的清單檢視） ─────────────────────────────

const TEAM_VIEW_KEY = 'hills.team.view';
type TeamViewMode = 'cards' | 'list';

function readTeamView(): TeamViewMode {
  try {
    return localStorage.getItem(TEAM_VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

/** 團隊頁（ui-spec「團隊」v0.38，D58）：依小組分組，卡片或清單檢視，圓形頭像。 */
function TeamList({ overview }: { overview: Overview }) {
  const { members, teams, offices } = overview;
  const [view, setView] = useState<TeamViewMode>(readTeamView);
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
  const back = (m: MemberView) =>
    m.until
      ? t('home.until', {
          time: m.presence === 'Leave' ? formatDate(m.until) : formatClock(m.until),
        })
      : null;
  return (
    <div className="flex flex-col gap-5 p-1">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted">
          {t('team.summary', { online, total: members.length })}
        </p>
        <SegmentedControl
          label={t('team.view.label')}
          value={view}
          onChange={(v) => {
            setView(v);
            try {
              localStorage.setItem(TEAM_VIEW_KEY, v);
            } catch {
              // 只是記住檢視方式
            }
          }}
          options={[
            { value: 'cards', label: t('team.view.cards') },
            { value: 'list', label: t('team.view.list') },
          ]}
        />
      </div>
      {members.length <= 1 && <EmptyState art="team">{t('team.empty')}</EmptyState>}
      {grouped.map((g) => {
        const on = g.list.filter((m) => m.presence && m.presence !== 'Offline').length;
        const leads = g.leads.map((id) => byId.get(id)).filter((m): m is MemberView => Boolean(m));
        return (
          <section key={g.id || 'none'} className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <h2 className="font-bold">{g.name}</h2>
              <span className="text-xs text-muted">
                {t('chat.membersCount', { count: g.list.length })} ·{' '}
                {t('team.online', { online: on })}
                {leads.length > 0 && ` · ${t('team.leads')}`}
              </span>
              {leads.map((m) => (
                <Avatar key={m.id} member={m} size={22} />
              ))}
            </div>
            {view === 'cards' ? (
              <ul className="grid grid-cols-5 gap-3 wide:grid-cols-6">
                {g.list.map((m) => (
                  <li key={m.id}>
                    <Card
                      padding="sm"
                      className={`flex h-full flex-col items-center gap-2 text-center ${m.isMe ? 'ring-2 ring-primary' : ''}`}
                    >
                      <Avatar member={m} size={64} me={m.isMe} />
                      <span className="font-bold">
                        {m.name}
                        {m.isMe && <span className="font-normal text-muted">{t('team.you')}</span>}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full bg-bg px-2.5 py-0.5 text-xs font-semibold ${statusTextClass[m.presence ?? 'Offline']}`}
                      >
                        {stateLabel(m.presence)}
                        {back(m) && ` · ${back(m)}`}
                      </span>
                      <span className="text-xs text-muted">
                        {locationLabel(m.location, offices)}
                      </span>
                      <span className="w-full truncate text-xs text-muted">{m.note}</span>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <Card padding="sm">
                <ul className="flex flex-col divide-y divide-line">
                  {g.list.map((m) => (
                    <li
                      key={m.id}
                      className="grid grid-cols-[2.5rem_10rem_7rem_14rem_1fr] items-center gap-3 py-2"
                    >
                      <Avatar member={m} size={40} me={m.isMe} />
                      <span className="truncate font-semibold">
                        {m.name}
                        {m.isMe && <span className="font-normal text-muted">{t('team.you')}</span>}
                        {m.isAdmin && <Badge className="ml-2 font-normal">{t('team.admin')}</Badge>}
                      </span>
                      <StatusBadge state={m.presence} />
                      <span className="truncate text-sm text-muted">
                        {locationLabel(m.location, offices)}
                        {back(m) && ` · ${back(m)}`}
                      </span>
                      <span className="truncate text-sm text-muted">{m.note}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}
