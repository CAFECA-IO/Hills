/** 對話「焦點營地」（ui-spec「聊天」焦點營地，D43；technical-design §14.2 v0.14）。 */
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  api,
  isPrivateTask,
  type ConvRow,
  type MemberView,
  type MessageView,
  type Task,
  type TeamView,
} from './api';
import { AttachmentCard } from './attachments';
import { firstLine, reportableStep } from './camp-utils';
import { StatusBadge } from './figures';
import { SaveToKb } from './kb';
import { formatClock, formatDate, formatTime, t, type MessageKey } from './i18n';
import { parseAttachments, type Attachment } from './share';
import {
  Button,
  Checkbox,
  Chip,
  EmptyState,
  ErrorText,
  ListButton,
  Popover,
  Select,
  Tabs,
  TextInput,
  useAction,
} from './ui';

const MAX_STEPS_SHOWN = 6;

type NameOf = (id: string) => string;

/** 「本對話的山」：連結任務的步驟檢查點（橫向縮小版）＋ 更換 / 取消連結。 */
export function ConvMountain({
  conv,
  task,
  missing,
  tasks,
  teams,
  nameOf,
}: {
  conv: ConvRow;
  task: Task | null;
  missing: boolean;
  tasks: Task[];
  teams: TeamView[];
  nameOf: NameOf;
}) {
  const [picking, setPicking] = useState(false);
  const pickBtn = useRef<HTMLButtonElement>(null);
  const { busy, error, attempt } = useAction();
  const unlink = () => void attempt(() => api.setConvTask(conv.id, null));
  return (
    <div className="relative border-b border-line bg-primary-soft/40 px-4 py-2">
      <div className="flex items-center gap-4">
        {task ? (
          <>
            <div className="flex w-44 shrink-0 flex-col">
              <span className="text-xs text-muted">{t('camp.mountain')}</span>
              <span className="truncate text-sm font-bold" title={task.title}>
                {task.title}
              </span>
              <span className="text-xs text-muted">
                {task.dueAt ? t('camp.due', { time: formatDue(task.dueAt) }) : t('camp.noDue')}
              </span>
            </div>
            <StepStrip task={task} nameOf={nameOf} />
          </>
        ) : (
          <p className="flex-1 text-sm text-muted">
            {missing ? t('camp.missing') : t('camp.empty')}
          </p>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            ref={pickBtn}
            variant="secondary"
            size="sm"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
          >
            {task || missing ? t('camp.change') : t('camp.pick')}
          </Button>
          {(task || missing) && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={unlink}>
              {t('camp.unlink')}
            </Button>
          )}
        </div>
      </div>
      <ErrorText message={error} />
      {picking && (
        <TaskPicker
          tasks={tasks}
          teams={teams}
          current={task}
          anchorRef={pickBtn}
          onClose={() => setPicking(false)}
          onPick={(x) =>
            void attempt(() => api.setConvTask(conv.id, { team: x.team, id: x.id })).then(
              (ok) => ok && setPicking(false),
            )
          }
        />
      )}
    </div>
  );
}

function formatDue(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? formatClock(ms) : formatDate(ms);
}

/** 步驟檢查點：完成（勾）/ 目前（實心）/ 未完成（虛線），右端為山頂旗子；略微上升排列。 */
function StepStrip({ task, nameOf }: { task: Task; nameOf: NameOf }) {
  const steps = task.steps;
  if (steps.length === 0) {
    return <p className="flex-1 text-xs text-muted">{t('camp.noSteps')}</p>;
  }
  const current = steps.findIndex((s) => !s.done);
  const pivot = current === -1 ? steps.length - 1 : current;
  const start = Math.max(
    0,
    Math.min(pivot - Math.floor(MAX_STEPS_SHOWN / 2), steps.length - MAX_STEPS_SHOWN),
  );
  const shown = steps.slice(start, start + MAX_STEPS_SHOWN);
  const before = start;
  const after = steps.length - start - shown.length;
  const done = steps.filter((s) => s.done).length;
  return (
    <ol
      className="flex min-w-0 flex-1 items-end gap-0"
      aria-label={t('home.scene.label', { title: task.title, done, total: steps.length })}
    >
      {before > 0 && <li className="self-center px-1 text-xs text-muted">+{before}</li>}
      {shown.map((s, i) => {
        const idx = start + i;
        const state = s.done ? 'done' : idx === current ? 'current' : 'todo';
        const lift = Math.round((idx / Math.max(steps.length, 1)) * 10);
        return (
          <li
            key={s.id}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5"
            style={{ transform: `translateY(-${lift}px)` }}
          >
            <span className="flex w-full items-center">
              <span
                aria-hidden
                className={`h-0.5 flex-1 ${i === 0 && before === 0 ? 'opacity-0' : ''} ${s.done || state === 'current' ? 'bg-primary' : 'border-t-2 border-dashed border-line'}`}
              />
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold ${
                  state === 'done'
                    ? 'bg-st-online text-on-primary'
                    : state === 'current'
                      ? 'bg-primary text-on-primary ring-4 ring-primary/25'
                      : 'border-2 border-line bg-surface text-muted'
                }`}
              >
                {state === 'done' ? '✓' : idx + 1}
              </span>
              <span
                aria-hidden
                className={`h-0.5 flex-1 ${s.done ? 'bg-primary' : 'border-t-2 border-dashed border-line'}`}
              />
            </span>
            <span
              className={`max-w-full truncate text-2xs ${state === 'current' ? 'font-bold text-primary' : 'text-muted'}`}
              title={`${s.title} · ${s.assignee ? nameOf(s.assignee) : t('home.unassigned')}`}
            >
              {s.title}
            </span>
            <span className="sr-only">
              {t(`camp.step.${state}` as MessageKey)} ·{' '}
              {s.assignee ? nameOf(s.assignee) : t('home.unassigned')}
            </span>
          </li>
        );
      })}
      {after > 0 && <li className="self-center px-1 text-xs text-muted">+{after}</li>}
      <li aria-hidden className="self-start pl-1 text-lg leading-none text-primary">
        ⚑
      </li>
    </ol>
  );
}

/** 選擇要連結的任務：我所屬小組的未完成任務。 */
function TaskPicker({
  tasks,
  teams,
  current,
  anchorRef,
  onPick,
  onClose,
}: {
  tasks: Task[];
  teams: TeamView[];
  current: Task | null;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (task: Task) => void;
  onClose: () => void;
}) {
  const open = tasks.filter((x) => x.status !== 'done' && !isPrivateTask(x));
  const teamName = (id: string) => teams.find((x) => x.id === id)?.name ?? '';
  return (
    <Popover
      label={t('camp.pick')}
      onClose={onClose}
      anchorRef={anchorRef}
      className="scroll-panel absolute top-full right-4 mt-1 max-h-72 w-80 p-2"
    >
      {open.length === 0 && (
        <EmptyState art="tasks" className="p-2">
          {t('camp.pick.empty')}
        </EmptyState>
      )}
      <ul className="flex flex-col">
        {open.map((x) => (
          <li key={`${x.team}:${x.id}`}>
            <ListButton
              onClick={() => onPick(x)}
              selected={current?.id === x.id}
              className="justify-between"
            >
              <span className="truncate">{x.title}</span>
              <span className="shrink-0 text-xs text-muted">{teamName(x.team)}</span>
            </ListButton>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex justify-end">
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </Popover>
  );
}

/** 訊息流中的系統列：連結任務、步驟完成。 */
export function SystemRow({ children, at }: { children: ReactNode; at: number }) {
  return (
    <li className="flex items-center gap-2 px-2 text-xs text-muted">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="max-w-[70%] truncate">{children}</span>
      <span>{formatTime(at)}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </li>
  );
}

export function linkRowText(m: MessageView, tasks: Task[], nameOf: NameOf): string {
  if (!m.task) return t('camp.row.unlinked', { name: nameOf(m.author) });
  const link = m.task;
  const title = tasks.find((x) => x.team === link.team && x.id === link.id)?.title;
  return t('camp.row.linked', {
    name: nameOf(m.author),
    title: title ?? t('camp.row.hiddenTask'),
  });
}

/** 敲門提示（D40）：對方在會議、午休或專注時，訊息會在回來後提醒。 */
export function KnockHint({ targets }: { targets: MemberView[] }) {
  if (targets.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-1 border-t border-line bg-bg px-4 py-2 text-xs">
      {targets.map((m) => (
        <p key={m.id} className="flex items-center gap-2">
          <StatusBadge state={m.presence} withText={false} size={14} />
          {m.until
            ? t('camp.knock', {
                name: m.name,
                state: t(`presence.${m.presence ?? 'Offline'}` as MessageKey),
                time: formatClock(m.until),
              })
            : t('camp.knock.noTime', {
                name: m.name,
                state: t(`presence.${m.presence ?? 'Offline'}` as MessageKey),
              })}
        </p>
      ))}
    </div>
  );
}

/** 訊息快速動作：回報步驟完成、變成任務（「存成知識」隨知識庫加入，D42）。 */
export function MessageActions({
  m,
  conv,
  me,
  task,
  teams,
  myTeams,
}: {
  m: MessageView;
  conv: ConvRow;
  me: string;
  task: Task | null;
  teams: TeamView[];
  myTeams: string[];
}) {
  const [making, setMaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const { busy, error, attempt } = useAction();
  const step = reportableStep(task, me);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {step && task && (
          <Chip
            disabled={busy}
            onClick={() => void attempt(() => api.setStepDone(task.team, task.id, step.id, true))}
            title={step.title}
          >
            {t('camp.action.report')}
          </Chip>
        )}
        {myTeams.length > 0 && (
          <Chip
            aria-expanded={making}
            onClick={() => {
              setSaving(false);
              setMaking((v) => !v);
            }}
          >
            {t('camp.action.toTask')}
          </Chip>
        )}
        {m.body.trim() && (
          <Chip
            aria-expanded={saving}
            onClick={() => {
              setMaking(false);
              setSaving((v) => !v);
            }}
          >
            {t('camp.action.toKb')}
          </Chip>
        )}
      </div>
      {saving && (
        <SaveToKb
          conv={conv.id}
          messageKey={`${m.author}:${m.id}`}
          defaultTitle={firstLine(m.body) || t('camp.toTask.untitled')}
          onDone={() => setSaving(false)}
        />
      )}
      <ErrorText message={error} />
      {making && (
        <MakeTaskForm
          m={m}
          conv={conv}
          teams={teams.filter((x) => myTeams.includes(x.id))}
          onDone={() => setMaking(false)}
        />
      )}
    </div>
  );
}

function MakeTaskForm({
  m,
  conv,
  teams,
  onDone,
}: {
  m: MessageView;
  conv: ConvRow;
  teams: TeamView[];
  onDone: () => void;
}) {
  const [title, setTitle] = useState(() => firstLine(m.body) || t('camp.toTask.untitled'));
  const [team, setTeam] = useState(teams[0]?.id ?? '');
  const [link, setLink] = useState(conv.task === null);
  const { busy, error, attempt } = useAction();
  const submit = async () => {
    if (!title.trim() || !team) return;
    const ok = await attempt(async () => {
      const id = await api.createTask(team, {
        title: title.trim(),
        assignee: null,
        dueAt: null,
        steps: [],
      });
      if (link) await api.setConvTask(conv.id, { team, id });
    });
    if (ok) onDone();
  };
  return (
    <form
      className="flex w-80 flex-col gap-2 rounded-card bg-surface p-3 text-sm shadow-lg"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('camp.toTask.title')}</span>
        <TextInput
          size="sm"
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {teams.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('camp.toTask.team')}</span>
          <Select size="sm" value={team} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <Checkbox
        label={t('camp.toTask.link')}
        checked={link}
        onChange={(e) => setLink(e.target.checked)}
      />
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>
          {t('camp.toTask.create')}
        </Button>
      </div>
    </form>
  );
}

// ── 右側抽屜：成員 / 檔案 / 任務 ─────────────────────────────

export type DrawerTab = 'members' | 'files' | 'task';

/** 已載入訊息中的附件，新到舊。 */
function convFiles(
  msgs: MessageView[],
): { a: Attachment; author: string; createdAt: number; key: string }[] {
  const out: { a: Attachment; author: string; createdAt: number; key: string }[] = [];
  for (const m of msgs) {
    if (m.kind !== 'files') continue;
    parseAttachments(m.attachments).forEach((a, i) =>
      out.push({ a, author: m.author, createdAt: m.createdAt, key: `${m.author}:${m.id}:${i}` }),
    );
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

export function ConvDrawer({
  conv,
  me,
  members,
  msgs,
  task,
  missing,
  nameOf,
  membersPanel,
}: {
  conv: ConvRow;
  me: string;
  members: MemberView[];
  msgs: MessageView[];
  task: Task | null;
  missing: boolean;
  nameOf: NameOf;
  /** 群組成員面板（沿用既有元件） */
  membersPanel: ReactNode;
}) {
  const [tab, setTab] = useState<DrawerTab>('members');
  const files = convFiles(msgs);
  const other =
    conv.kind === 'dm' ? members.find((x) => x.id !== me && conv.members.includes(x.id)) : null;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line wide:w-80">
      <Tabs
        label={t('camp.drawer')}
        fill
        className="px-2"
        value={tab}
        onChange={setTab}
        options={(['members', 'files', 'task'] as const).map((k) => ({
          value: k,
          label: `${t(`camp.tab.${k}` as MessageKey)}${k === 'files' && files.length > 0 ? ` · ${files.length}` : ''}`,
        }))}
      />
      <div className="scroll-panel min-h-0 flex-1">
        {tab === 'members' &&
          (other ? (
            <div className="flex flex-col gap-2 p-4 text-sm">
              <span className="font-bold">{other.name}</span>
              <StatusBadge state={other.presence} />
              {other.until && (
                <span className="text-xs text-muted">
                  {t('camp.until', { time: formatClock(other.until) })}
                </span>
              )}
              {other.note && <span className="text-xs text-muted">{other.note}</span>}
            </div>
          ) : (
            membersPanel
          ))}
        {tab === 'files' && (
          <div className="flex flex-col gap-2 p-3">
            {files.length === 0 && <EmptyState art="report">{t('camp.files.empty')}</EmptyState>}
            {files.map((f) => (
              <AttachmentCard
                key={f.key}
                a={f.a}
                author={members.find((x) => x.id === f.author)}
                createdAt={f.createdAt}
              />
            ))}
          </div>
        )}
        {tab === 'task' && <TaskTab task={task} missing={missing} me={me} nameOf={nameOf} />}
      </div>
    </aside>
  );
}

function TaskTab({
  task,
  missing,
  me,
  nameOf,
}: {
  task: Task | null;
  missing: boolean;
  me: string;
  nameOf: NameOf;
}) {
  const { busy, error, attempt } = useAction();
  if (!task) {
    return (
      <EmptyState art="tasks" className="p-4">
        {missing ? t('camp.missing') : t('camp.empty')}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex flex-col">
        <span className="font-bold">{task.title}</span>
        <span className="text-xs text-muted">
          {task.dueAt ? t('camp.due', { time: formatDue(task.dueAt) }) : t('camp.noDue')}
        </span>
      </div>
      {task.steps.length === 0 && <p className="text-xs text-muted">{t('camp.noSteps')}</p>}
      <ol className="flex flex-col gap-2">
        {task.steps.map((s, i) => {
          const mine = s.assignee === me;
          return (
            <li key={s.id} className="flex items-start gap-2">
              <Checkbox
                className="mt-1"
                checked={s.done}
                disabled={!mine || busy}
                aria-label={s.title}
                onChange={(e) =>
                  void attempt(() => api.setStepDone(task.team, task.id, s.id, e.target.checked))
                }
              />
              <span className="flex min-w-0 flex-col">
                <span className={s.done ? 'text-muted line-through' : ''}>
                  {i + 1}. {s.title}
                </span>
                <span className="text-xs text-muted">
                  {s.assignee ? nameOf(s.assignee) : t('home.unassigned')}
                  {s.done && s.doneAt ? ` · ${formatTime(s.doneAt)}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <ErrorText message={error} />
    </div>
  );
}
