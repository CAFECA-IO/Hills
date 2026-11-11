/**
 * 任務頁（ui-spec「任務」，D40、D46）：依小組與「私人」分組的清單、勾選步驟，
 * 以及目標頁共用的新增 / 編輯任務對話框（任務可連結一個週目標、可設為私人）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  isPrivateTask,
  PRIVATE_TEAM,
  taskProgress,
  type FocusView,
  type MemberView,
  type PlanView,
  type StepInput,
  type Task,
  type TeamView,
} from './api';
import { BreakdownDialog } from './assign-breakdown';
import { AssignBoard } from './assign-board';
import { loadOf, loads, sortByLoad } from './assign-utils';
import { periodsAt, weekGoalOptions } from './goals-utils';
import { useLoad } from './hooks';
import { formatClock, t } from './i18n';
import { TaskCloseDialog } from './task-close';
import { TaskDetail } from './task-detail';
import { blockedDays, canClose, closeIsPrimary } from './task-utils';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorText,
  Field,
  IconButton,
  MarkdownEditor,
  Pressable,
  ProgressBar,
  SegmentedControl,
  Select,
  TextInput,
  Toast,
  useAction,
} from './ui';

interface Props {
  tasks: Task[];
  teams: TeamView[];
  members: MemberView[];
  focus: FocusView | null;
  timezone: string;
  error: string | null;
  isAdmin?: boolean;
  /** 任務還沒載入（顯示骨架） */
  loading?: boolean;
  /** 展開並捲到這個任務（前往出處，D64） */
  openTaskId?: string | null;
  /** 固定檢視（「工作 › 小組 › 分派板」用 board），不顯示切換 */
  forceView?: 'list' | 'board';
}

type View = 'list' | 'board';
const VIEW_KEY = 'hills.tasks.view';
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
};

/** 新增任務時的預填值（目標頁「拆成任務」、任務欄「+ 任務」）。 */
export interface TaskDraft {
  team?: string;
  planItemId?: string | null;
  /** 來源小組目標（D50） */
  teamGoalId?: string | null;
}

export function Tasks({
  tasks,
  teams,
  members,
  focus,
  timezone,
  error,
  isAdmin = false,
  loading = false,
  forceView,
  openTaskId = null,
}: Props) {
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const plans = useLoad(() => api.plans(false), ['doc', 'org', 'roster']);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  const me = members.find((m) => m.isMe);
  const myTeams = teams.filter(
    (tm) => me && (tm.members.includes(me.id) || tm.leads.includes(me.id)),
  );
  const [viewState, setViewState] = useState<View>(readView);
  const view = forceView ?? viewState;
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 本機偏好，存不了就算了
    }
  };
  const [boardTeam, setBoardTeam] = useState('');
  const team = myTeams.find((x) => x.id === boardTeam) ?? myTeams[0];
  const [breakdown, setBreakdown] = useState(false);
  const [closing, setClosing] = useState<Task | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const canBreak = Boolean(team && (isAdmin || (me && team.leads.includes(me.id))));
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.name ?? '?') : t('home.unassigned');
  const goalOf = (id: string | null) =>
    id ? (plans.data?.find((p) => p.id === id) ?? null) : null;
  const groups: { key: string; name: string; list: Task[] }[] = [
    ...myTeams.map((tm) => ({
      key: tm.id,
      name: tm.name,
      list: tasks.filter((x) => x.team === tm.id),
    })),
    { key: PRIVATE_TEAM, name: t('tasks.private'), list: tasks.filter(isPrivateTask) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {!forceView && (
          <SegmentedControl
            label={t('assign.view.label')}
            options={[
              { value: 'list', label: t('assign.view.list') },
              { value: 'board', label: t('assign.view.board') },
            ]}
            value={view}
            onChange={setView}
          />
        )}
        {view === 'board' && myTeams.length > 0 && (
          <Select
            size="sm"
            aria-label={t('assign.team')}
            className="w-auto"
            value={team?.id ?? ''}
            onChange={(e) => setBoardTeam(e.target.value)}
          >
            {myTeams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
        <p className="text-sm text-muted">
          {t('tasks.summary', { count: tasks.filter((x) => x.status !== 'done').length })}
        </p>
        <span className="flex-1" />
        {view === 'board' && canBreak && (
          <Button variant="secondary" onClick={() => setBreakdown(true)}>
            {t('assign.breakdown')}
          </Button>
        )}
        <Button onClick={() => setEditing('new')}>{t('tasks.new')}</Button>
      </div>
      <ErrorText message={error} />
      {breakdown && team && (
        <BreakdownDialog
          team={team}
          teamGoals={dirs.data?.teamGoals ?? []}
          members={members}
          timezone={timezone}
          onClose={() => setBreakdown(false)}
        />
      )}
      {editing && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          teams={myTeams}
          members={members}
          timezone={timezone}
          onClose={() => setEditing(null)}
        />
      )}
      {closing && (
        <TaskCloseDialog
          task={closing}
          onClose={() => setClosing(null)}
          onDone={() => setToast(t('close.done', { title: closing.title }))}
        />
      )}
      {toast && <Toast key={toast} message={toast} onClose={() => setToast(null)} />}
      {view === 'board' &&
        (team ? (
          <AssignBoard
            team={team}
            tasks={tasks}
            members={members}
            plans={plans.data ?? []}
            isAdmin={isAdmin}
            timezone={timezone}
            onEdit={(x) => setEditing(x)}
          />
        ) : (
          <EmptyState art="team">{t('assign.noTeams')}</EmptyState>
        ))}
      {view === 'list' && tasks.length === 0 && (
        <Card className="flex flex-col items-stretch gap-2">
          <EmptyState art="tasks" loading={loading}>
            {t('tasks.empty')}
          </EmptyState>
        </Card>
      )}
      {groups.map((g) => {
        if (view !== 'list' || g.list.length === 0) return null;
        return (
          <Card key={g.key} className="flex flex-col gap-1">
            <h2 className="mb-2 font-bold">{g.name}</h2>
            <ul className="flex flex-col divide-y divide-line">
              {g.list.map((x) => (
                <TaskRow
                  key={x.id}
                  task={x}
                  goal={goalOf(x.planItemId)}
                  linked={Boolean(x.planItemId)}
                  isFocus={focus?.task?.id === x.id}
                  jumpTo={openTaskId === x.id}
                  nameOf={nameOf}
                  me={me?.id ?? ''}
                  members={members}
                  teams={teams}
                  onEdit={() => setEditing(x)}
                  onClose={() => setClosing(x)}
                />
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  goal,
  linked,
  isFocus,
  nameOf,
  me,
  members,
  teams,
  onEdit,
  onClose,
  jumpTo = false,
}: {
  task: Task;
  goal: PlanView | null;
  linked: boolean;
  isFocus: boolean;
  /** 前往出處：預設展開、捲到這列並短暫高亮 */
  jumpTo?: boolean;
  nameOf: (id: string | null) => string;
  me: string;
  members: MemberView[];
  teams: TeamView[];
  onEdit: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(isFocus || jumpTo);
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (jumpTo) rowRef.current?.scrollIntoView({ block: 'center' });
  }, [jumpTo]);
  const [now] = useState(() => Date.now());
  const { error, attempt } = useAction();
  const done = task.steps.filter((s) => s.done).length;
  const priv = isPrivateTask(task);
  return (
    <li
      ref={rowRef}
      className={`flex flex-col gap-2 py-3 ${jumpTo ? 'hills-flash rounded-control' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Pressable
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 flex-col rounded-sm"
        >
          <span
            className={`truncate font-semibold ${task.status === 'done' ? 'text-muted line-through' : ''}`}
          >
            {task.title}
          </span>
          {linked && (
            <span className="truncate text-xs text-muted">
              {t('tasks.goalOf', {
                goal: goal ? `${goal.period} · ${goal.title}` : t('goals.privateItem'),
              })}
            </span>
          )}
        </Pressable>
        {isFocus && <Badge tone="primary">{t('tasks.focus')}</Badge>}
        {task.blocked && task.status !== 'done' && (
          <Badge tone="alert">
            {t('tasks.blocked', { days: blockedDays(task.blocked.since, now) })}
          </Badge>
        )}
        {!priv && <span className="text-sm text-muted">{nameOf(task.assignee)}</span>}
        <span className="text-sm text-muted">
          {task.dueAt ? formatClock(task.dueAt) : t('tasks.noDue')}
        </span>
        {task.steps.length > 0 && (
          <span className="flex items-center gap-2 text-sm">
            <ProgressBar
              size="sm"
              className="w-16"
              barClassName="bg-st-online"
              value={taskProgress(task) / 100}
              label={t('tasks.progress', { done, total: task.steps.length })}
            />
            {done} / {task.steps.length}
          </span>
        )}
        {canClose(task, me) && (
          <Button
            variant={closeIsPrimary(task, me) ? 'primary' : 'secondary'}
            size="sm"
            onClick={onClose}
          >
            {t('tasks.close')}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {t('tasks.edit')}
        </Button>
      </div>
      {open && (
        <TaskDetail
          task={task}
          members={members}
          teams={teams}
          steps={
            task.steps.length > 0 && (
              <ol className="flex flex-col gap-1">
                {task.steps.map((s) => (
                  <li key={s.id}>
                    <Checkbox
                      checked={s.done}
                      onChange={(e) =>
                        void attempt(() =>
                          api.setStepDone(task.team, task.id, s.id, e.target.checked),
                        )
                      }
                      label={
                        <>
                          <span className={s.done ? 'text-muted line-through' : ''}>{s.title}</span>
                          {!priv && <span className="text-muted"> · {nameOf(s.assignee)}</span>}
                        </>
                      }
                    />
                  </li>
                ))}
              </ol>
            )
          }
        />
      )}
      <ErrorText message={error} />
    </li>
  );
}

const toLocalInput = (ms: number | null) => {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 新增 / 編輯任務（ui-spec「任務」v0.18：模態對話框，目標頁與任務頁共用）。 */
export function TaskDialog({
  task,
  draft,
  teams,
  members,
  timezone,
  onClose,
  onSaved,
}: {
  task: Task | null;
  draft?: TaskDraft;
  teams: TeamView[];
  members: MemberView[];
  timezone: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const me = members.find((m) => m.isMe)?.id ?? '';
  const plans = useLoad(() => api.plans(false), ['doc', 'org', 'roster']);
  const allTasks = useLoad(api.tasks, ['doc']);
  const [thisWeek] = useState(() => periodsAt(Date.now(), timezone).week);
  const load = loads(allTasks.data ?? [], thisWeek, timezone);
  const initial = useMemo(
    () => ({
      team: task?.team ?? draft?.team ?? teams[0]?.id ?? PRIVATE_TEAM,
      title: task?.title ?? '',
      assignee: task ? (task.assignee ?? '') : me,
      due: toLocalInput(task?.dueAt ?? null),
      estimate: task?.estimate ? String(task.estimate / 60) : '',
      planItemId: task?.planItemId ?? draft?.planItemId ?? '',
      brief: task?.brief ?? '',
      acceptance: task?.acceptance.map((c) => ({ id: c.id as string | null, text: c.text })) ?? [],
      steps:
        task?.steps.map((s): StepInput => ({
          id: s.id,
          title: s.title,
          assignee: s.assignee,
          done: s.done,
        })) ?? [],
    }),
    // 只在開啟時取一次初始值
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [v, setV] = useState(initial);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const { busy, error, attempt } = useAction();
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const priv = v.team === PRIVATE_TEAM;
  const teamMembers = members.filter((m) =>
    teams.find((x) => x.id === v.team)?.members.includes(m.id),
  );
  const goalOwner = priv ? me : v.assignee || me;
  const goals = weekGoalOptions(plans.data ?? [], goalOwner, thisWeek);
  // 指派給別人、對方沒有我看得到的本週以後週目標：週目標讓他接下時選（D50）
  const forOther = !priv && Boolean(v.assignee) && v.assignee !== me;
  const later = forOther && !goals.some((g) => g.period >= thisWeek);
  const assigneeLabel = (m: MemberView) => {
    const l = loadOf(load, m.id);
    const key =
      m.presence === 'Leave'
        ? 'tasks.assignee.leave'
        : l.heavy
          ? 'tasks.assignee.heavy'
          : 'tasks.assignee.load';
    return t(key, { name: m.name, open: l.open, due: l.dueThisWeek });
  };
  const linked = v.planItemId ? (plans.data ?? []).find((p) => p.id === v.planItemId) : null;
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const setStep = (i: number, patch: Partial<StepInput>) =>
    set({ steps: v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= v.steps.length) return;
    const next = [...v.steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ steps: next });
  };
  const save = async () => {
    if (!v.title.trim()) {
      setTitleError(t('field.required'));
      titleRef.current?.focus();
      return;
    }
    const input = {
      title: v.title,
      assignee: priv ? me : v.assignee || null,
      status: task?.status ?? null,
      dueAt: v.due ? new Date(v.due).getTime() : null,
      // 預估時數（D62）：0 = 清除
      estimate: v.estimate.trim() ? Math.round(Math.max(0, Number(v.estimate)) * 60) : 0,
      steps: v.steps
        .filter((s) => s.title.trim())
        .map((s) => (priv ? { ...s, assignee: null } : s)),
      planItemId: v.planItemId || null,
      teamGoalId: priv ? null : (task?.teamGoalId ?? draft?.teamGoalId ?? null),
      brief: v.brief.trim() ? v.brief : '',
      acceptance: v.acceptance.filter((c) => c.text.trim()),
    };
    let id = task?.id ?? '';
    const ok = await attempt(async () => {
      if (task) await api.updateTask(task.team, task.id, input);
      else id = await api.createTask(v.team, input);
    });
    if (ok) {
      onSaved?.(id);
      onClose();
    }
  };
  return (
    <Dialog
      title={task ? t('tasks.edit.title') : t('tasks.new')}
      onClose={onClose}
      onSubmit={() => void save()}
      dirty={dirty}
      width="lg"
      footer={
        <DialogFooter
          start={
            <>
              {task && (
                <ConfirmButton
                  label={t('tasks.delete')}
                  message={t('tasks.delete.confirm', { title: task.title })}
                  onConfirm={async () => {
                    if (await attempt(() => api.deleteTask(task.team, task.id))) onClose();
                  }}
                />
              )}
            </>
          }
        >
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      }
    >
      <Field
        label={t('tasks.field.visibility')}
        hint={priv ? t('tasks.vis.hint.private') : t('tasks.vis.hint.team')}
      >
        <Select
          value={v.team}
          disabled={Boolean(task)}
          onChange={(e) => set({ team: e.target.value, assignee: me })}
        >
          {teams.map((x) => (
            <option key={x.id} value={x.id}>
              {t('goals.vis.teamNamed', { team: x.name })}
            </option>
          ))}
          <option value={PRIVATE_TEAM}>{t('tasks.vis.private')}</option>
        </Select>
      </Field>
      <Field label={t('tasks.field.title')} required error={titleError}>
        <TextInput
          ref={titleRef}
          autoFocus
          maxLength={200}
          value={v.title}
          onChange={(e) => {
            set({ title: e.target.value });
            if (e.target.value.trim()) setTitleError(null);
          }}
        />
      </Field>
      <Field
        label={t('tasks.field.goal')}
        hint={later && !v.planItemId ? t('tasks.goal.laterHint') : t('tasks.goal.hint')}
      >
        <Select value={v.planItemId} onChange={(e) => set({ planItemId: e.target.value })}>
          <option value="">{forOther ? t('tasks.goal.later') : t('tasks.goal.none')}</option>
          {v.planItemId && !goals.some((g) => g.id === v.planItemId) && (
            <option value={v.planItemId}>
              {linked ? `${linked.period} · ${linked.title}` : t('goals.privateItem')}
            </option>
          )}
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.period.split('-')[1]} · {g.title}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        {!priv && (
          <Field label={t('tasks.field.assignee')}>
            <Select
              value={v.assignee}
              onChange={(e) => set({ assignee: e.target.value, planItemId: '' })}
            >
              <option value="">{t('home.unassigned')}</option>
              {sortByLoad(teamMembers, load).map((m) => (
                <option key={m.id} value={m.id}>
                  {assigneeLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('tasks.field.due')}>
          <TextInput
            type="datetime-local"
            value={v.due}
            onChange={(e) => set({ due: e.target.value })}
          />
        </Field>
        <Field label={t('tasks.field.estimate')} hint={t('tasks.estimate.hours')}>
          <TextInput
            type="number"
            min={0}
            step={0.5}
            value={v.estimate}
            onChange={(e) => set({ estimate: e.target.value })}
          />
        </Field>
      </div>
      <MarkdownEditor
        label={t('tasks.field.brief')}
        value={v.brief}
        onChange={(brief) => set({ brief })}
        rows={4}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted">
          {t('tasks.field.acceptance')}
        </legend>
        {v.acceptance.map((c, i) => (
          <div key={c.id ?? `new-${i}`} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-sm text-muted">○</span>
            <TextInput
              size="sm"
              maxLength={200}
              aria-label={t('tasks.criterion.text', { n: i + 1 })}
              className="min-w-0 flex-1"
              value={c.text}
              onChange={(e) =>
                set({
                  acceptance: v.acceptance.map((x, j) =>
                    j === i ? { ...x, text: e.target.value } : x,
                  ),
                })
              }
            />
            <IconButton
              size="sm"
              label={t('tasks.criterion.remove')}
              className="hover:text-danger"
              onClick={() => set({ acceptance: v.acceptance.filter((_, j) => j !== i) })}
            >
              ×
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={v.acceptance.length >= 20}
            onClick={() => set({ acceptance: [...v.acceptance, { id: null, text: '' }] })}
          >
            {t('tasks.criterion.add')}
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted">{t('tasks.field.steps')}</legend>
        {v.steps.length === 0 && <EmptyState art="none">{t('tasks.steps.empty')}</EmptyState>}
        {v.steps.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-sm text-muted">{i + 1}</span>
            <TextInput
              size="sm"
              aria-label={t('tasks.step.title', { n: i + 1 })}
              className="min-w-0 flex-1"
              value={s.title}
              onChange={(e) => setStep(i, { title: e.target.value })}
            />
            {!priv && (
              <Select
                size="sm"
                className="w-32 shrink-0"
                aria-label={t('tasks.step.assignee', { n: i + 1 })}
                value={s.assignee ?? ''}
                onChange={(e) => setStep(i, { assignee: e.target.value || null })}
              >
                <option value="">{t('home.unassigned')}</option>
                {teamMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
            <IconButton size="sm" label={t('tasks.step.up')} onClick={() => move(i, -1)}>
              ↑
            </IconButton>
            <IconButton size="sm" label={t('tasks.step.down')} onClick={() => move(i, 1)}>
              ↓
            </IconButton>
            <IconButton
              size="sm"
              label={t('tasks.step.remove')}
              className="hover:text-danger"
              onClick={() => set({ steps: v.steps.filter((_, j) => j !== i) })}
            >
              ×
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              set({ steps: [...v.steps, { id: null, title: '', assignee: null, done: false }] })
            }
          >
            {t('tasks.step.add')}
          </Button>
        </div>
      </fieldset>
      <ErrorText message={error} />
    </Dialog>
  );
}
