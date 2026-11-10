/**
 * 從小組目標一次拆給多人（ui-spec「任務 → 分派」v0.29，D50）：一行一件任務，右側即時顯示
 * 分配後的負荷，「建立 N 件並通知」依序建立。
 */
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api, type MemberView, type TeamGoal, type TeamView } from './api';
import {
  addRows,
  loadOf,
  loads,
  parseLines,
  rowsToCreate,
  sortByLoad,
  type DraftRow,
} from './assign-utils';
import { periodsAt } from './goals-utils';
import { useLoad } from './hooks';
import { t } from './i18n';
import {
  Badge,
  Button,
  Dialog,
  DialogFooter,
  ErrorText,
  Field,
  IconButton,
  ProgressBar,
  Select,
  TextInput,
  useAction,
} from './ui';

type Row = { title: string; assignee: string; due: string };

const blank = (): Row => ({ title: '', assignee: '', due: '' });
/** 日期欄 → 當天 18:00（本機時間） */
const dueOf = (d: string) => (d ? new Date(`${d}T18:00`).getTime() : null);

export function BreakdownDialog({
  team,
  teamGoals,
  goalId,
  members,
  timezone,
  onClose,
  onDone,
}: {
  team: TeamView;
  teamGoals: TeamGoal[];
  goalId?: string | null;
  members: MemberView[];
  timezone: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tasks = useLoad(api.tasks, ['doc']);
  const [now] = useState(() => Date.now());
  const thisWeek = periodsAt(now, timezone).week;
  const goals = teamGoals.filter((g) => g.team === team.id);
  const [goal, setGoal] = useState(goalId ?? goals[0]?.id ?? '');
  const [rows, setRows] = useState<Row[]>([blank()]);
  const { busy, error, attempt } = useAction();
  const people = members.filter((m) => team.members.includes(m.id) || team.leads.includes(m.id));
  const drafts: DraftRow[] = rows.map((r) => ({
    title: r.title,
    assignee: r.assignee || null,
    dueAt: dueOf(r.due),
  }));
  const toCreate = rowsToCreate(drafts);
  const before = loads(tasks.data ?? [], thisWeek, timezone);
  const after = addRows(before, drafts, thisWeek, timezone);
  const picked = sortByLoad(
    people.filter((m) => drafts.some((d) => d.assignee === m.id)),
    before,
  );
  const selected = goals.find((g) => g.id === goal);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r));
      // 最後一列有內容時自動多一列
      if (next[next.length - 1]?.title.trim()) next.push(blank());
      return next;
    });
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (i === rows.length - 1 && rows[i]?.title.trim()) setRows((rs) => [...rs, blank()]);
  };
  const onPaste = (i: number) => (e: ClipboardEvent) => {
    const lines = parseLines(e.clipboardData.getData('text'));
    if (lines.length < 2) return;
    e.preventDefault();
    setRows((rs) => {
      const head = rs.slice(0, i).concat(rs.slice(i + 1).filter((r) => r.title.trim()));
      return [...head, ...lines.map((title) => ({ ...blank(), title })), blank()];
    });
  };
  const create = async () => {
    let done = 0;
    const ok = await attempt(async () => {
      for (const [n, r] of toCreate.entries()) {
        try {
          await api.createTask(team.id, {
            title: r.title,
            assignee: r.assignee,
            status: null,
            dueAt: r.dueAt,
            steps: [],
            planItemId: null,
            teamGoalId: goal || null,
          });
          done += 1;
        } catch (err) {
          // 已建立的列移除，留下失敗與之後的列
          const created = new Set(toCreate.slice(0, done).map((c) => c.title));
          setRows((rs) => rs.filter((x) => !created.has(x.title.trim())));
          throw new Error(t('breakdown.partial', { done, n: n + 1, error: String(err) }), {
            cause: err,
          });
        }
      }
    });
    if (ok) {
      onDone?.();
      onClose();
    }
  };

  return (
    <Dialog
      title={t('breakdown.title')}
      onClose={onClose}
      onSubmit={() => void create()}
      dirty={toCreate.length > 0}
      width="lg"
      footer={
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={toCreate.length === 0}>
            {t('breakdown.create', { count: toCreate.length })}
          </Button>
        </DialogFooter>
      }
    >
      <Field label={t('breakdown.goal')}>
        <Select value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="">{t('breakdown.noGoal')}</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.year} · {g.title}
            </option>
          ))}
        </Select>
      </Field>
      {selected && selected.keyResults.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.keyResults.map((kr) => (
            <Badge key={kr.id}>{kr.title}</Badge>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_8rem_9rem_2rem] gap-2 text-xs font-bold text-muted">
            <span>{t('breakdown.col.title')}</span>
            <span>{t('breakdown.col.assignee')}</span>
            <span>{t('breakdown.col.due')}</span>
            <span />
          </div>
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
            {rows.map((r, i) => (
              <li
                key={i}
                className="grid grid-cols-[minmax(0,1fr)_8rem_9rem_2rem] items-center gap-2"
              >
                <TextInput
                  aria-label={t('breakdown.row.title', { n: i + 1 })}
                  placeholder={i === rows.length - 1 ? t('breakdown.placeholder') : undefined}
                  maxLength={200}
                  value={r.title}
                  autoFocus={i === 0}
                  onChange={(e) => setRow(i, { title: e.target.value })}
                  onKeyDown={onKey(i)}
                  onPaste={onPaste(i)}
                />
                <Select
                  aria-label={t('breakdown.row.assignee', { n: i + 1 })}
                  value={r.assignee}
                  onChange={(e) => setRow(i, { assignee: e.target.value })}
                >
                  <option value="">{t('assign.unassigned')}</option>
                  {people.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                <TextInput
                  type="date"
                  aria-label={t('breakdown.row.due', { n: i + 1 })}
                  value={r.due}
                  onChange={(e) => setRow(i, { due: e.target.value })}
                />
                {r.title.trim() ? (
                  <IconButton
                    size="sm"
                    label={t('breakdown.row.remove', { n: i + 1 })}
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    ✕
                  </IconButton>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t('breakdown.hint')}</p>
        </div>
        <aside
          aria-label={t('breakdown.load')}
          className="flex flex-col gap-2 rounded-control bg-bg p-3"
        >
          <span className="font-bold">{t('breakdown.load')}</span>
          <span className="text-xs text-muted">{t('breakdown.load.hint')}</span>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {picked.map((m) => {
              const b = loadOf(before, m.id);
              const a = loadOf(after, m.id);
              const leave = m.presence === 'Leave';
              return (
                <div key={m.id} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{m.name}</span>
                    <span
                      className={`text-xs ${a.heavy ? 'font-bold text-warning' : 'text-muted'}`}
                    >
                      {t('breakdown.load.change', { from: b.open, to: a.open })}
                      {a.heavy ? ` · ${t('breakdown.heavy')}` : ''}
                    </span>
                  </div>
                  <ProgressBar value={Math.min(a.open / 8, 1)} size="sm" label={m.name} />
                  {leave && <span className="text-xs text-danger">{t('breakdown.leaveWarn')}</span>}
                </div>
              );
            })}
          </div>
        </aside>
      </div>
      <ErrorText message={error} />
    </Dialog>
  );
}
