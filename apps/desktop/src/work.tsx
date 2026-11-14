/**
 * 「工作」（ui-spec「工作」v0.42，D59）：今天 · 這週 · 目標 · 小組；
 * 「所有任務」與「週五收尾」是分頁裡的子畫面，左上「‹ 回到工作」回來。
 */
import { useContext, useState, type ReactNode } from 'react';
import {
  api,
  type FocusView,
  type MemberView,
  type Task,
  type TeamGoal,
  type TeamView,
} from './api';
import { DEFAULT_RULES } from './drift-utils';
import { Goals } from './goals';
import { HillView, useWalkers } from './hill';
import { useLoad } from './hooks';
import { navigate } from './nav';
import { t } from './i18n';
import { HeadContext, PageHead } from './layout';
import { Reports } from './reports';
import { ExportButton } from './report-export';
import { TeamOverview } from './team-overview';
import { periodsAt } from './goals-utils';
import { Tasks } from './tasks';
import { Today } from './today';
import {
  Button,
  EmptyState,
  ErrorText,
  LinkButton,
  ProgressBar,
  SegmentedControl,
  Select,
  TextInput,
  useAction,
} from './ui';
import { Week } from './week';

export type WorkTab = 'today' | 'week' | 'goals' | 'team';
export type WorkSub = 'tasks' | 'friday' | null;
type TeamView2 = 'overview' | 'board' | 'direction';

const TAB_KEY = 'hills.work.tab';
const TEAM_KEY = 'hills.work.team';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // 本機偏好，存不了就算了
  }
}

export const readWorkTab = () =>
  read<WorkTab>(TAB_KEY, ['today', 'week', 'goals', 'team'], 'today');

interface Props {
  tab: WorkTab;
  sub: WorkSub;
  onNavigate: (tab: WorkTab, sub: WorkSub) => void;
  tasks: Task[];
  tasksError: string | null;
  tasksLoading: boolean;
  members: MemberView[];
  teams: TeamView[];
  focus: FocusView | null;
  timezone: string;
  isAdmin: boolean;
  /** 前往出處（D64）：在「所有任務」展開這個任務 */
  openTask?: string | null;
}

/** 子頁面的標題換成「工作」；子頁面的動作接在分頁之後。 */
function SubHead({ children }: { children: ReactNode }) {
  const slots = useContext(HeadContext);
  return (
    <HeadContext.Provider value={{ title: null, actions: slots.actions }}>
      {children}
    </HeadContext.Provider>
  );
}

export function Work({
  tab,
  sub,
  onNavigate,
  tasks,
  tasksError,
  tasksLoading,
  members,
  teams,
  focus,
  timezone,
  isAdmin,
  openTask = null,
}: Props) {
  const focusId = focus?.task?.id ?? null;
  const go = (next: WorkTab) => {
    write(TAB_KEY, next);
    onNavigate(next, null);
  };
  const back = <LinkButton onClick={() => onNavigate(tab, null)}>{t('work.back')}</LinkButton>;
  const tabs = (
    <SegmentedControl
      label={t('work.tabs')}
      options={(['today', 'week', 'goals', 'team'] as const).map((v) => ({
        value: v,
        label: t(`work.tab.${v}`),
      }))}
      value={tab}
      onChange={go}
    />
  );
  const title =
    sub === 'tasks' ? t('work.allTasks') : sub === 'friday' ? t('work.friday') : t('nav.work');

  let body: ReactNode;
  if (sub === 'tasks') {
    body = (
      <div className="scroll-panel flex h-full flex-col gap-3">
        <div>{back}</div>
        <Tasks
          tasks={tasks}
          teams={teams}
          members={members}
          focus={focus}
          timezone={timezone}
          error={tasksError}
          isAdmin={isAdmin}
          loading={tasksLoading}
          forceView="list"
          openTaskId={openTask}
        />
      </div>
    );
  } else if (sub === 'friday') {
    body = (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div>{back}</div>
        <div className="min-h-0 flex-1">
          <Reports members={members} teams={teams} tasks={tasks} timezone={timezone} />
        </div>
      </div>
    );
  } else if (tab === 'today') {
    body = (
      <Today
        tasks={tasks}
        members={members}
        teams={teams}
        focusId={focusId}
        timezone={timezone}
        onAllTasks={() => onNavigate('today', 'tasks')}
        onTeam={() => go('team')}
      />
    );
  } else if (tab === 'week') {
    body = (
      <Week
        tasks={tasks}
        members={members}
        teams={teams}
        timezone={timezone}
        onFriday={() => onNavigate('week', 'friday')}
      />
    );
  } else if (tab === 'goals') {
    body = (
      <Goals
        members={members}
        teams={teams}
        tasks={tasks}
        focusId={focusId}
        timezone={timezone}
        noAutoWeekly
        scope="mine"
      />
    );
  } else {
    body = (
      <TeamTab
        tasks={tasks}
        members={members}
        teams={teams}
        focus={focus}
        timezone={timezone}
        isAdmin={isAdmin}
        tasksError={tasksError}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHead title={title} actions={tabs} />
      <div className="min-h-0 flex-1">
        <SubHead>{body}</SubHead>
      </div>
    </div>
  );
}

/** 小組分頁（ui-spec「工作 › 小組」A5、A6）：總覽 · 分派板 · 方向（往山丘走）。 */
function TeamTab({
  tasks,
  members,
  teams,
  focus,
  timezone,
  isAdmin,
  tasksError,
}: {
  tasks: Task[];
  members: MemberView[];
  teams: TeamView[];
  focus: FocusView | null;
  timezone: string;
  isAdmin: boolean;
  tasksError: string | null;
}) {
  const [view, setViewState] = useState<TeamView2>(() =>
    read<TeamView2>(TEAM_KEY, ['overview', 'board', 'direction'], 'overview'),
  );
  const setView = (v: TeamView2) => {
    setViewState(v);
    write(TEAM_KEY, v);
  };
  const me = members.find((m) => m.isMe)?.id ?? '';
  const myTeams = teams.filter((x) => x.members.includes(me) || x.leads.includes(me));
  const [teamSel, setTeam] = useState<string | null>(null);
  const team = myTeams.find((x) => x.id === teamSel) ?? myTeams[0] ?? null;
  const [now] = useState(() => Date.now());
  const periods = periodsAt(now, timezone);
  const summaries = useLoad(api.directionSummaries, ['doc', 'org', 'roster']);
  const rules = useLoad(api.directionRules, ['org']);
  const dirs = useLoad(api.directions, ['doc', 'org', 'roster']);
  const notes = useLoad(api.weekNotes, ['doc', 'org', 'roster']);
  const walkers = useWalkers(
    members,
    team ?? { id: '', name: '', members: [], leads: [] },
    summaries.data ?? [],
    rules.data ?? DEFAULT_RULES,
    periods,
    now,
  );
  if (!team) return <EmptyState art="team">{t('assign.noTeams')}</EmptyState>;
  const isLead = isAdmin || team.leads.includes(me);
  const goals = (dirs.data?.teamGoals ?? []).filter(
    (g) => g.team === team.id && g.year === periods.year,
  );
  const note = (notes.data ?? []).find((n) => n.team === team.id && n.week === periods.week);
  const message = (member: string) =>
    void api.openDm(member).then(
      (conv) => navigate({ page: 'chat', conv }),
      () => undefined,
    );
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {myTeams.length > 1 && (
          <Select
            size="sm"
            className="w-auto"
            aria-label={t('assign.team')}
            value={team.id}
            onChange={(e) => setTeam(e.target.value)}
          >
            {myTeams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
        <SegmentedControl
          label={t('work.team.view')}
          options={(['overview', 'board', 'direction'] as const).map((v) => ({
            value: v,
            label: t(`work.team.${v}`),
          }))}
          value={view}
          onChange={setView}
        />
        <span className="flex-1" />
        {isLead && (
          <ExportButton
            label={t('exp.team')}
            initialKind="weekly"
            initialScope={team.id}
            members={members}
            teams={teams}
            tasks={tasks}
            timezone={timezone}
          />
        )}
      </div>
      <TeamBar
        team={team}
        goals={goals}
        note={note?.text ?? ''}
        week={periods.week}
        canEdit={isLead}
        onSaved={notes.reload}
      />
      <div className="min-h-0 flex-1">
        {view === 'overview' && (
          <TeamOverview
            team={team}
            members={members}
            tasks={tasks}
            walkers={walkers}
            periods={periods}
            timezone={timezone}
            isLead={isLead}
            onBoard={() => setView('board')}
            onMessage={message}
          />
        )}
        {view === 'board' && (
          <div className="scroll-panel h-full">
            <Tasks
              tasks={tasks}
              teams={teams}
              members={members}
              focus={focus}
              timezone={timezone}
              error={tasksError}
              isAdmin={isAdmin}
              forceView="board"
            />
          </div>
        )}
        {view === 'direction' && (
          <HillView
            team={team}
            goal={goals[0] ?? null}
            walkers={walkers}
            periods={periods}
            meId={me}
            onMessage={message}
          />
        )}
      </div>
    </div>
  );
}

/** 上方列：小組目標與進度、這週重點（負責人可編輯）。 */
function TeamBar({
  team,
  goals,
  note,
  week,
  canEdit,
  onSaved,
}: {
  team: TeamView;
  goals: TeamGoal[];
  note: string;
  week: string;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-primary-soft px-4 py-2.5 text-sm">
      <span className="font-bold text-primary">{team.name}</span>
      {goals.length === 0 ? (
        <span className="text-xs text-muted">{t('ogsm.noGoals')}</span>
      ) : (
        goals.slice(0, 2).map((g) => (
          <span key={g.id} className="flex min-w-48 items-center gap-2 text-xs">
            <span className="max-w-48 truncate font-semibold">{g.title}</span>
            <ProgressBar size="sm" className="w-20" value={g.progress / 100} label={g.title} />
            <span>{Math.round(g.progress)}%</span>
          </span>
        ))
      )}
      <span className="flex-1" />
      {editing !== null ? (
        <span className="flex items-center gap-2">
          <TextInput
            autoFocus
            className="w-72"
            maxLength={200}
            aria-label={t('tov.note')}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
          />
          <Button
            size="sm"
            busy={busy}
            onClick={async () => {
              if (await attempt(() => api.setWeekNote(team.id, week, editing))) {
                setEditing(null);
                onSaved();
              }
            }}
          >
            {t('common.save')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </Button>
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <span className="text-muted">{t('tov.note')}</span>
          <span className="max-w-96 truncate font-semibold">{note || t('tov.noNote')}</span>
          {canEdit && (
            <LinkButton className="text-xs" onClick={() => setEditing(note)}>
              {t('tov.editNote')}
            </LinkButton>
          )}
        </span>
      )}
      <ErrorText message={error} />
    </div>
  );
}
