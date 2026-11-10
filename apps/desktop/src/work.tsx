/**
 * 「工作」（ui-spec「工作」v0.42，D59）：今天 · 這週 · 目標 · 小組；
 * 「所有任務」與「週五收尾」是分頁裡的子畫面，左上「‹ 回到工作」回來。
 */
import { useContext, useState, type ReactNode } from 'react';
import type { FocusView, MemberView, Task, TeamView } from './api';
import { Goals } from './goals';
import { t } from './i18n';
import { HeadContext, PageHead } from './layout';
import { Reports } from './reports';
import { TeamOverview } from './scrum';
import { periodsAt } from './goals-utils';
import { Tasks } from './tasks';
import { Today } from './today';
import { LinkButton, SegmentedControl } from './ui';
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

/** 小組分頁（第 2 批暫時版）：總覽 = 小組今天的每日任務；分派板；方向 = 原團隊方向。 */
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
  const [team, setTeam] = useState<string | null>(null);
  const teamId = team ?? myTeams[0]?.id ?? '';
  const [now] = useState(() => Date.now());
  const today = periodsAt(now, timezone).day;
  const switcher = (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        label={t('work.team.view')}
        options={(['overview', 'board', 'direction'] as const).map((v) => ({
          value: v,
          label: t(`work.team.${v}`),
        }))}
        value={view}
        onChange={setView}
      />
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {switcher}
      <div className="min-h-0 flex-1">
        {view === 'overview' && (
          <div className="scroll-panel h-full">
            <TeamOverview
              teams={myTeams}
              teamId={teamId}
              onTeam={setTeam}
              members={members}
              date={today}
            />
          </div>
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
          <Goals
            members={members}
            teams={teams}
            tasks={tasks}
            focusId={focus?.task?.id ?? null}
            timezone={timezone}
            noAutoWeekly
            scope="team"
          />
        )}
      </div>
    </div>
  );
}
