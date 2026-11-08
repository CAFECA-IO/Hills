/** 任務頁（ui-spec「任務」M1 第一批範圍，D40）：清單、新增 / 編輯對話框、勾選步驟。 */
import { useState } from 'react';
import {
  api,
  type FocusView,
  type MemberView,
  type StepInput,
  type Task,
  type TeamView,
} from './api';
import { formatClock, t } from './i18n';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  IconButton,
  Pressable,
  ProgressBar,
  Select,
  TextInput,
  useAction,
} from './ui';

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
          <EmptyState>{t('tasks.empty')}</EmptyState>
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
        <Pressable
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`min-w-0 flex-1 truncate rounded-sm font-semibold ${task.status === 'done' ? 'text-muted line-through' : ''}`}
        >
          {task.title}
        </Pressable>
        {isFocus && <Badge tone="primary">{t('tasks.focus')}</Badge>}
        <span className="text-sm text-muted">{nameOf(task.assignee)}</span>
        <span className="text-sm text-muted">
          {task.dueAt ? formatClock(task.dueAt) : t('tasks.noDue')}
        </span>
        {task.steps.length > 0 && (
          <span className="flex items-center gap-2 text-sm">
            <ProgressBar
              size="sm"
              className="w-16"
              barClassName="bg-st-online"
              value={done / task.steps.length}
              label={t('tasks.progress', { done, total: task.steps.length })}
            />
            {done} / {task.steps.length}
          </span>
        )}
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {t('tasks.edit')}
        </Button>
      </div>
      {open && task.steps.length > 0 && (
        <ol className="flex flex-col gap-1 pl-2">
          {task.steps.map((s) => (
            <li key={s.id}>
              <Checkbox
                checked={s.done}
                onChange={(e) =>
                  void attempt(() => api.setStepDone(task.team, task.id, s.id, e.target.checked))
                }
                label={
                  <>
                    <span className={s.done ? 'text-muted line-through' : ''}>{s.title}</span>
                    <span className="text-muted"> · {nameOf(s.assignee)}</span>
                  </>
                }
              />
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
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-bold">{task ? t('tasks.edit.title') : t('tasks.new')}</h2>
      {!task && teams.length > 1 && (
        <Field label={t('tasks.team')}>
          <Select value={team} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t('tasks.field.title')} value={title} onChange={setTitle} autoFocus />
      <div className="flex flex-wrap gap-4">
        <Field label={t('tasks.field.assignee')}>
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('home.unassigned')}</option>
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('tasks.field.due')}>
          <TextInput type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted">{t('tasks.field.steps')}</legend>
        {steps.length === 0 && <EmptyState>{t('tasks.steps.empty')}</EmptyState>}
        {steps.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
            <span className="w-6 text-right text-sm text-muted">{i + 1}</span>
            <TextInput
              aria-label={t('tasks.step.title', { n: i + 1 })}
              className="min-w-48 flex-1"
              value={s.title}
              onChange={(e) => setStep(i, { title: e.target.value })}
            />
            <Select
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
            <IconButton variant="secondary" label={t('tasks.step.up')} onClick={() => move(i, -1)}>
              ↑
            </IconButton>
            <IconButton variant="secondary" label={t('tasks.step.down')} onClick={() => move(i, 1)}>
              ↓
            </IconButton>
            <IconButton
              variant="secondary"
              label={t('tasks.step.remove')}
              onClick={() => setSteps((list) => list.filter((_, j) => j !== i))}
            >
              ×
            </IconButton>
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
