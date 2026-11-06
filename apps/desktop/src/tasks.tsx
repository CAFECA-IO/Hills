/** 任務頁（ui-spec「任務」M1 第一批範圍，D40）：清單、新增 / 編輯對話框、勾選步驟。 */
import { useId, useState } from 'react';
import {
  api,
  type FocusView,
  type MemberView,
  type StepInput,
  type Task,
  type TeamView,
} from './api';
import { formatClock, t } from './i18n';
import { Button, Card, ConfirmButton, ErrorText, Field, useAction } from './ui';

interface Props {
  tasks: Task[];
  teams: TeamView[];
  members: MemberView[];
  focus: FocusView | null;
  error: string | null;
}

export function Tasks({ tasks, teams, members, focus, error }: Props) {
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const me = members.find((m) => m.isMe);
  const myTeams = teams.filter((tm) => me && tm.members.includes(me.id));
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.name ?? '?') : t('home.unassigned');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {t('tasks.summary', { count: tasks.filter((x) => x.status !== 'done').length })}
        </p>
        <Button disabled={myTeams.length === 0} onClick={() => setEditing('new')}>
          {t('tasks.new')}
        </Button>
      </div>
      <ErrorText message={error} />
      {editing && (
        <TaskDialog
          task={editing === 'new' ? null : editing}
          teams={myTeams}
          members={members}
          onClose={() => setEditing(null)}
        />
      )}
      {tasks.length === 0 && !editing && (
        <Card className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted">{t('tasks.empty')}</p>
        </Card>
      )}
      {myTeams.map((tm) => {
        const list = tasks.filter((x) => x.team === tm.id);
        if (list.length === 0) return null;
        return (
          <Card key={tm.id} className="flex flex-col gap-1">
            <h2 className="mb-2 font-bold">{tm.name}</h2>
            <ul className="flex flex-col divide-y divide-line">
              {list.map((x) => (
                <TaskRow
                  key={x.id}
                  task={x}
                  isFocus={focus?.task?.id === x.id}
                  nameOf={nameOf}
                  onEdit={() => setEditing(x)}
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
  isFocus,
  nameOf,
  onEdit,
}: {
  task: Task;
  isFocus: boolean;
  nameOf: (id: string | null) => string;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(isFocus);
  const { error, attempt } = useAction();
  const done = task.steps.filter((s) => s.done).length;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`min-w-0 flex-1 truncate text-left font-semibold ${task.status === 'done' ? 'text-muted line-through' : ''}`}
        >
          {task.title}
        </button>
        {isFocus && (
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-bold text-primary">
            {t('tasks.focus')}
          </span>
        )}
        <span className="text-sm text-muted">{nameOf(task.assignee)}</span>
        <span className="text-sm text-muted">
          {task.dueAt ? formatClock(task.dueAt) : t('tasks.noDue')}
        </span>
        {task.steps.length > 0 && (
          <span className="flex items-center gap-2 text-sm">
            <span
              className="h-2 w-16 overflow-hidden rounded-full bg-line"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={task.steps.length}
              aria-valuenow={done}
              aria-label={t('tasks.progress', { done, total: task.steps.length })}
            >
              <span
                className="block h-2 rounded-full bg-st-online"
                style={{ width: `${(done / task.steps.length) * 100}%` }}
              />
            </span>
            {done} / {task.steps.length}
          </span>
        )}
        <Button variant="secondary" className="px-3 py-1" onClick={onEdit}>
          {t('tasks.edit')}
        </Button>
      </div>
      {open && task.steps.length > 0 && (
        <ol className="flex flex-col gap-1 pl-2">
          {task.steps.map((s) => (
            <li key={s.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={s.done}
                  onChange={(e) =>
                    void attempt(() => api.setStepDone(task.team, task.id, s.id, e.target.checked))
                  }
                />
                <span className={s.done ? 'text-muted line-through' : ''}>{s.title}</span>
                <span className="text-muted">· {nameOf(s.assignee)}</span>
              </label>
            </li>
          ))}
        </ol>
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

function TaskDialog({
  task,
  teams,
  members,
  onClose,
}: {
  task: Task | null;
  teams: TeamView[];
  members: MemberView[];
  onClose: () => void;
}) {
  const [team, setTeam] = useState(task?.team ?? teams[0]?.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [assignee, setAssignee] = useState(task?.assignee ?? members.find((m) => m.isMe)?.id ?? '');
  const [due, setDue] = useState(toLocalInput(task?.dueAt ?? null));
  const [steps, setSteps] = useState<StepInput[]>(
    task?.steps.map((s) => ({ id: s.id, title: s.title, assignee: s.assignee, done: s.done })) ??
      [],
  );
  const { busy, error, attempt } = useAction();
  const ids = { team: useId(), assignee: useId(), due: useId() };
  const teamMembers = members.filter((m) =>
    teams.find((x) => x.id === team)?.members.includes(m.id),
  );
  const setStep = (i: number, patch: Partial<StepInput>) =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const save = async () => {
    const input = {
      title,
      assignee: assignee || null,
      status: task?.status ?? null,
      dueAt: due ? new Date(due).getTime() : null,
      steps: steps.filter((s) => s.title.trim()),
    };
    const ok = await attempt(() =>
      task ? api.updateTask(task.team, task.id, input) : api.createTask(team, input),
    );
    if (ok) onClose();
  };
  const select = 'rounded-control border border-line bg-surface px-3 py-2 text-sm';
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-bold">{task ? t('tasks.edit.title') : t('tasks.new')}</h2>
      {!task && teams.length > 1 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.team} className="text-sm font-medium">
            {t('tasks.team')}
          </label>
          <select
            id={ids.team}
            className={select}
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          >
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <Field label={t('tasks.field.title')} value={title} onChange={setTitle} autoFocus />
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.assignee} className="text-sm font-medium">
            {t('tasks.field.assignee')}
          </label>
          <select
            id={ids.assignee}
            className={select}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{t('home.unassigned')}</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.due} className="text-sm font-medium">
            {t('tasks.field.due')}
          </label>
          <input
            id={ids.due}
            type="datetime-local"
            className={select}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('tasks.field.steps')}</legend>
        {steps.length === 0 && <p className="text-sm text-muted">{t('tasks.steps.empty')}</p>}
        {steps.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
            <span className="w-6 text-right text-sm text-muted">{i + 1}</span>
            <input
              aria-label={t('tasks.step.title', { n: i + 1 })}
              className={`${select} min-w-48 flex-1`}
              value={s.title}
              onChange={(e) => setStep(i, { title: e.target.value })}
            />
            <select
              aria-label={t('tasks.step.assignee', { n: i + 1 })}
              className={select}
              value={s.assignee ?? ''}
              onChange={(e) => setStep(i, { assignee: e.target.value || null })}
            >
              <option value="">{t('home.unassigned')}</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              className="px-2 py-1"
              aria-label={t('tasks.step.up')}
              onClick={() => move(i, -1)}
            >
              ↑
            </Button>
            <Button
              variant="secondary"
              className="px-2 py-1"
              aria-label={t('tasks.step.down')}
              onClick={() => move(i, 1)}
            >
              ↓
            </Button>
            <Button
              variant="secondary"
              className="px-2 py-1"
              aria-label={t('tasks.step.remove')}
              onClick={() => setSteps((list) => list.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="soft"
            onClick={() =>
              setSteps((list) => [...list, { id: null, title: '', assignee: null, done: false }])
            }
          >
            {t('tasks.step.add')}
          </Button>
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !title.trim() || (!task && !team)} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {task && (
          <span className="ml-auto">
            <ConfirmButton
              label={t('tasks.delete')}
              message={t('tasks.delete.confirm', { title: task.title })}
              onConfirm={async () => {
                if (await attempt(() => api.deleteTask(task.team, task.id))) onClose();
              }}
            />
          </span>
        )}
      </div>
      <ErrorText message={error} />
    </Card>
  );
}
