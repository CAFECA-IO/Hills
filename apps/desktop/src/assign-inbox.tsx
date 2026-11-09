/**
 * 首頁「新指派給你」（ui-spec「任務 → 分派」v0.29，D50）：接下時選或建立自己的週目標；
 * 有困難時附一句原因，私訊給指派者。週目標只由本人建立（D47）。
 */
import { useState } from 'react';
import { api, type MemberView, type PlanView, type Task, type TeamGoal } from './api';
import { assignedToMe, inputOf } from './assign-utils';
import { periodsAt, weekGoalOptions } from './goals-utils';
import { useLoad } from './hooks';
import { formatClock, t } from './i18n';
import { Badge, Button, Card, ErrorText, Radio, TextArea, useAction } from './ui';

const CREATE = '__create__';
const NONE = '';

export function AssignedCard({
  tasks,
  members,
  timezone,
}: {
  tasks: Task[];
  members: MemberView[];
  timezone: string;
}) {
  const me = members.find((m) => m.isMe)?.id ?? null;
  const list = assignedToMe(tasks, me);
  const plans = useLoad(() => api.plans(false), ['doc', 'org', 'roster']);
  const dirs = useLoad(api.directions, ['doc', 'org']);
  if (list.length === 0 || !me) return null;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-medium">
        {t('assigned.title')}
        <Badge tone="primary">{list.length}</Badge>
      </h2>
      {list.map((task) => (
        <AssignedItem
          key={task.id}
          task={task}
          me={me}
          members={members}
          plans={plans.data ?? []}
          teamGoals={dirs.data?.teamGoals ?? []}
          timezone={timezone}
        />
      ))}
    </Card>
  );
}

function AssignedItem({
  task,
  me,
  members,
  plans,
  teamGoals,
  timezone,
}: {
  task: Task;
  me: string;
  members: MemberView[];
  plans: PlanView[];
  teamGoals: TeamGoal[];
  timezone: string;
}) {
  const [mode, setMode] = useState<'idle' | 'accept' | 'concern'>('idle');
  const [thisWeek] = useState(() => periodsAt(Date.now(), timezone).week);
  const goals = weekGoalOptions(plans, me, thisWeek).filter((g) => g.period >= thisWeek);
  const [picked, setGoal] = useState<string | null>(null);
  const goal = picked ?? goals[0]?.id ?? CREATE;
  const [note, setNote] = useState('');
  const { busy, error, attempt } = useAction();
  const by = members.find((m) => m.id === task.assignedBy)?.name ?? '?';
  const source = teamGoals.find((g) => g.id === task.teamGoalId);
  const concern = task.ack?.state === 'concern' ? task.ack : null;

  const accept = () =>
    attempt(async () => {
      let planItemId = goal === CREATE || goal === NONE ? null : goal;
      if (goal === CREATE) {
        planItemId = await api.savePlan({
          level: 'week',
          period: thisWeek,
          title: task.title,
          parentId: null,
          krRef: null,
          done: false,
          progressOverride: null,
          keyResults: [],
          visibility: { kind: 'team', team: task.team },
        });
      }
      if (planItemId && planItemId !== task.planItemId) {
        await api.updateTask(task.team, task.id, inputOf(task, { planItemId }));
      }
      await api.setTaskAck(task.team, task.id, 'accepted', null);
    });
  const raise = () =>
    attempt(async () => {
      const text = note.trim();
      await api.setTaskAck(task.team, task.id, 'concern', text);
      if (task.assignedBy) {
        const conv = await api.openDm(task.assignedBy);
        await api.sendMessage(
          conv,
          t('assigned.concern.message', { title: task.title, note: text }),
          [],
        );
      }
      setMode('idle');
      setNote('');
    });

  return (
    <article
      className={`flex flex-col gap-2 rounded-control border p-3 ${mode === 'idle' ? 'border-line' : 'border-primary'}`}
    >
      <div className="flex flex-col gap-0.5">
        <strong>{task.title}</strong>
        <span className="text-xs text-muted">
          {t('assigned.from', {
            name: by,
            due: task.dueAt ? formatClock(task.dueAt) : t('assigned.noDue'),
          })}
          {task.steps.length > 0 && ` · ${t('assigned.steps', { count: task.steps.length })}`}
        </span>
        {source && (
          <span className="text-xs text-muted">{t('assigned.source', { goal: source.title })}</span>
        )}
        {concern?.note && (
          <span className="text-xs text-warning">
            {t('assigned.concern.sent', { name: by, note: concern.note })}
          </span>
        )}
      </div>
      {mode === 'accept' && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1 text-xs font-bold">{t('assigned.goal')}</legend>
          {goals.map((g) => (
            <Radio
              key={g.id}
              name={`goal-${task.id}`}
              label={`${g.period.split('-')[1] ?? ''} · ${g.title}`}
              checked={goal === g.id}
              onChange={() => setGoal(g.id)}
            />
          ))}
          <Radio
            name={`goal-${task.id}`}
            label={t('assigned.goal.create', { title: task.title })}
            checked={goal === CREATE}
            onChange={() => setGoal(CREATE)}
          />
          <Radio
            name={`goal-${task.id}`}
            label={t('assigned.goal.none')}
            checked={goal === NONE}
            onChange={() => setGoal(NONE)}
          />
          <span className="text-xs text-muted">{t('assigned.goal.hint')}</span>
        </fieldset>
      )}
      {mode === 'concern' && (
        <label className="flex flex-col gap-1 text-xs font-bold">
          {t('assigned.concern.label', { name: by })}
          <TextArea
            rows={2}
            maxLength={200}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        {mode === 'idle' ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setMode('concern')}>
              {t('assigned.concern')}
            </Button>
            <Button size="sm" onClick={() => setMode('accept')}>
              {t('assigned.accept')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={() => setMode('idle')}>
              {t('common.cancel')}
            </Button>
            {mode === 'accept' ? (
              <Button size="sm" busy={busy} onClick={() => void accept()}>
                {t('assigned.accept')}
              </Button>
            ) : (
              <Button size="sm" busy={busy} disabled={!note.trim()} onClick={() => void raise()}>
                {t('assigned.concern.send')}
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
}
