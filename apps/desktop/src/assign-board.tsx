/**
 * 任務頁「依成員」分派板（ui-spec「任務 → 分派」v0.29，D50）：未指派欄 + 每位成員一欄，
 * 欄頭顯示負荷；負責人與管理者可拖曳卡片或用「指派給…」選單指派。
 */
import { useRef, useState, type DragEvent } from 'react';
import { api, type MemberView, type PlanView, type Task, type TeamView } from './api';
import { boardColumns, canAssign, inputOf, loadOf, loads, type Load } from './assign-utils';
import { Bust } from './figures';
import { periodsAt } from './goals-utils';
import { formatClock, t } from './i18n';
import { lookOf } from './summit';
import {
  Badge,
  ErrorText,
  IconButton,
  Menu,
  MenuItem,
  Pressable,
  ProgressBar,
  useAction,
} from './ui';

const UNASSIGNED = '';

export function AssignBoard({
  team,
  tasks,
  members,
  plans,
  isAdmin,
  timezone,
  onEdit,
}: {
  team: TeamView;
  tasks: Task[];
  members: MemberView[];
  plans: PlanView[];
  isAdmin: boolean;
  timezone: string;
  onEdit: (task: Task) => void;
}) {
  const me = members.find((m) => m.isMe)?.id ?? null;
  const editable = canAssign(team, me, isAdmin);
  const [now] = useState(() => Date.now());
  const thisWeek = periodsAt(now, timezone).week;
  const all = loads(tasks, thisWeek, timezone);
  const cols = boardColumns(tasks, team);
  const [over, setOver] = useState<string | null>(null);
  const { error, attempt } = useAction();
  const memberOf = (id: string) => members.find((m) => m.id === id);
  const people = cols.people
    .map((id) => memberOf(id))
    .filter((m): m is MemberView => Boolean(m))
    .sort((a, b) => a.name.localeCompare(b.name));
  const assign = async (task: Task, to: string) => {
    if ((task.assignee ?? UNASSIGNED) === to) return;
    await attempt(() =>
      api.updateTask(task.team, task.id, inputOf(task, { assignee: to || null })),
    );
  };
  const drop = (to: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    const task = tasks.find((x) => x.id === id);
    if (task && editable) void assign(task, to);
  };
  const dragOver = (to: string) => (e: DragEvent) => {
    if (!editable) return;
    e.preventDefault();
    setOver(to);
  };
  const goalOf = (id: string | null) => (id ? plans.find((p) => p.id === id) : undefined);
  const card = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      goal={goalOf(task.planItemId)}
      editable={editable}
      people={people}
      onAssign={(to) => void assign(task, to)}
      onEdit={() => onEdit(task)}
    />
  );
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {!editable && <p className="text-sm text-muted">{t('assign.readonly')}</p>}
      <ErrorText message={error} />
      <div className="flex gap-3 overflow-x-auto pb-2">
        <section
          aria-label={t('assign.unassigned')}
          className={`flex w-64 flex-none flex-col gap-2 rounded-card border border-dashed p-2 ${over === UNASSIGNED ? 'border-primary bg-primary-soft' : 'border-line'}`}
          onDragOver={dragOver(UNASSIGNED)}
          onDragLeave={() => setOver(null)}
          onDrop={drop(UNASSIGNED)}
        >
          <div className="flex flex-col gap-0.5 px-1">
            <span className="flex items-center gap-2 font-bold">
              {t('assign.unassigned')}
              <Badge>{cols.unassigned.length}</Badge>
            </span>
            {editable && <span className="text-xs text-muted">{t('assign.unassigned.hint')}</span>}
          </div>
          <ul className="flex flex-col gap-2">{cols.unassigned.map(card)}</ul>
        </section>
        {people.map((m) => {
          const list = cols.byMember[m.id] ?? [];
          return (
            <section
              key={m.id}
              aria-label={m.name}
              className={`flex w-64 flex-none flex-col gap-2 rounded-card p-2 ${over === m.id ? 'bg-primary-soft outline-2 outline-primary outline-dashed' : 'bg-bg'}`}
              onDragOver={dragOver(m.id)}
              onDragLeave={() => setOver(null)}
              onDrop={drop(m.id)}
            >
              <ColumnHead member={m} load={loadOf(all, m.id)} />
              {list.length === 0 && (
                <span className="px-1 text-xs text-muted">{t('assign.empty')}</span>
              )}
              <ul className="flex flex-col gap-2">{list.map(card)}</ul>
              {over === m.id && (
                <span className="rounded-control border border-dashed border-primary px-2 py-3 text-center text-sm text-primary">
                  {t('assign.dropHere', { name: m.name })}
                </span>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ColumnHead({ member, load }: { member: MemberView; load: Load }) {
  const leave = member.presence === 'Leave';
  return (
    <div className="flex flex-col gap-1 rounded-control bg-surface px-2 py-2">
      <div className="flex items-center gap-2">
        <Bust look={lookOf(member)} size={26} ring={leave ? 'line' : 'primary'} faded={leave} />
        <span className="min-w-0 flex-1 truncate font-bold">{member.name}</span>
        {leave && <Badge>{t('assign.leave')}</Badge>}
      </div>
      <ProgressBar
        value={Math.min(load.open / 8, 1)}
        size="sm"
        label={t('assign.load', { open: load.open, due: load.dueThisWeek })}
      />
      <span className={`text-xs ${load.heavy ? 'font-bold text-warning' : 'text-muted'}`}>
        {t(load.heavy ? 'assign.heavy' : 'assign.load', {
          open: load.open,
          due: load.dueThisWeek,
        })}
      </span>
    </div>
  );
}

function TaskCard({
  task,
  goal,
  editable,
  people,
  onAssign,
  onEdit,
}: {
  task: Task;
  goal: PlanView | undefined;
  editable: boolean;
  people: MemberView[];
  onAssign: (to: string) => void;
  onEdit: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const done = task.steps.filter((s) => s.done).length;
  const concern = task.ack?.state === 'concern' ? task.ack : null;
  return (
    <li
      draggable={editable}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      className={`relative flex flex-col gap-1.5 rounded-control border bg-surface px-3 py-2 text-sm ${task.pendingAck ? 'border-dashed border-line' : 'border-line'} ${editable ? 'cursor-grab' : ''}`}
    >
      <div className="flex items-start gap-2">
        <Pressable className="min-w-0 flex-1 font-semibold hover:underline" onClick={onEdit}>
          {task.title}
        </Pressable>
        {editable && (
          <IconButton
            ref={btn}
            size="sm"
            label={t('assign.assignTo.label', { title: task.title })}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </IconButton>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {task.pendingAck && !concern && <Badge tone="primary">{t('assign.pending')}</Badge>}
        {concern && <Badge>{t('assign.concern')}</Badge>}
        {goal ? (
          <Badge>{`${goal.period.split('-')[1] ?? ''} · ${goal.title}`}</Badge>
        ) : (
          task.pendingAck && <Badge>{t('assign.goalLater')}</Badge>
        )}
        <Badge>{task.dueAt ? formatClock(task.dueAt) : t('tasks.noDue')}</Badge>
      </div>
      {concern?.note && <span className="text-xs text-warning">「{concern.note}」</span>}
      {task.steps.length > 0 && (
        <span className="text-xs text-muted">
          {t('tasks.progress', { done, total: task.steps.length })}
        </span>
      )}
      {menu && (
        <Menu
          label={t('assign.assignTo')}
          onClose={() => setMenu(false)}
          anchorRef={btn}
          className="absolute top-9 right-2"
        >
          <MenuItem
            onSelect={() => {
              setMenu(false);
              onAssign(UNASSIGNED);
            }}
          >
            {t('assign.unassigned')}
          </MenuItem>
          {people.map((m) => (
            <MenuItem
              key={m.id}
              onSelect={() => {
                setMenu(false);
                onAssign(m.id);
              }}
            >
              {m.name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </li>
  );
}
