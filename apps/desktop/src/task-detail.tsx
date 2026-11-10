/**
 * 任務詳情（ui-spec「任務 → 執行紀錄與結案」v0.41，D53）：交付說明、完成條件、
 * （步驟由呼叫端插入）、執行紀錄時間軸、回報進度 / 卡住了（D60）/ 回覆 / 已解決、結案卡與退回。
 */
import { useState, type ReactNode } from 'react';
import { api, type MemberView, type Task, type TaskLog, type TeamView } from './api';
import { AttachmentCard } from './attachments';
import { parseSections, type DocFormat } from './doc-spec';
import { Avatar } from './figures';
import { useLoad } from './hooks';
import { formatTime, t, type MessageKey } from './i18n';
import { parseAttachments } from './share';
import {
  canAnswer,
  canBlock,
  canReopen,
  canReport,
  canResolve,
  lastClose,
  latestPercent,
} from './task-utils';
import {
  Badge,
  Button,
  Dialog,
  DocView,
  ErrorText,
  Field,
  LinkButton,
  Markdown,
  ProgressBar,
  SectionLabel,
  TextArea,
  TextInput,
  useAction,
} from './ui';

const KIND_LABEL: Record<TaskLog['kind'], MessageKey> = {
  start: 'tlog.kind.start',
  progress: 'tlog.kind.progress',
  // 「提出問題」已併入「卡住了」（D60）
  question: 'tlog.kind.blocked',
  answer: 'tlog.kind.answer',
  close: 'tlog.kind.close',
  reopen: 'tlog.kind.reopen',
  step: 'tlog.kind.step',
  blocked: 'tlog.kind.blocked',
  resolved: 'tlog.kind.resolved',
};

const isBlocked = (l: TaskLog) => l.kind === 'blocked' || l.kind === 'question';

export function TaskDetail({
  task,
  members,
  teams,
  steps,
}: {
  task: Task;
  members: MemberView[];
  teams: TeamView[];
  /** 步驟清單（由任務列提供，放在完成條件與紀錄之間） */
  steps?: ReactNode;
}) {
  const me = members.find((m) => m.isMe)?.id ?? '';
  const logs = useLoad(() => api.taskLogs(task.team, task.id), ['doc']);
  const report = useLoad(() => api.taskReport(task.team, task.id), ['doc']);
  const list = logs.data ?? [];
  const closed = lastClose(list);
  // 最新一份報告掛在最後一筆結案紀錄上（退回後仍可閱讀）
  const lastCloseLog = [...list].reverse().find((l) => l.kind === 'close');
  const percent = latestPercent(list);
  const result = (id: string) => report.data?.criteria.find((c) => c.id === id);
  const byId = new Map(members.map((m) => [m.id, m]));
  return (
    <div className="flex flex-col gap-3 pl-2">
      {task.brief && (
        <section className="flex flex-col gap-1">
          <SectionLabel>{t('tdetail.brief')}</SectionLabel>
          <Markdown variant="chat" className="text-sm">
            {task.brief}
          </Markdown>
        </section>
      )}
      {task.acceptance.length > 0 && (
        <section className="flex flex-col gap-1">
          <SectionLabel>{t('tdetail.acceptance')}</SectionLabel>
          <ul className="flex flex-col gap-1 text-sm">
            {task.acceptance.map((c) => {
              const r = task.status === 'done' ? result(c.id) : undefined;
              return (
                <li key={c.id} className="flex items-baseline gap-2">
                  <span
                    aria-label={r ? (r.met ? t('tdetail.met') : t('tdetail.notMet')) : undefined}
                    className={r ? (r.met ? 'text-st-online-text' : 'text-danger') : 'text-muted'}
                  >
                    {r ? (r.met ? '✓' : '✗') : '○'}
                  </span>
                  <span>
                    {c.text}
                    {r?.note && <span className="text-muted"> · {r.note}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {steps}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <SectionLabel>{t('tdetail.log')}</SectionLabel>
          {percent !== null && task.status !== 'done' && (
            <span className="flex items-center gap-2 text-xs text-muted">
              <ProgressBar
                size="sm"
                className="w-20"
                barClassName="bg-st-online"
                value={percent / 100}
                label={t('tdetail.percent', { p: percent })}
              />
              {percent}%
            </span>
          )}
        </div>
        <ErrorText message={logs.error} />
        {list.length === 0 && <p className="text-xs text-muted">{t('tdetail.log.empty')}</p>}
        <ol className="flex flex-col gap-2">
          {list.map((l) => (
            <LogItem
              key={`${l.author}:${l.id}`}
              log={l}
              task={task}
              author={byId.get(l.author)}
              name={byId.get(l.author)?.name ?? '?'}
              report={l === lastCloseLog ? report.data : null}
              canReopenIt={l === closed && canReopen(task, me, teams)}
              canResolveIt={task.blocked?.log === l.id && canResolve(task, me, teams)}
              onChanged={() => {
                logs.reload();
                report.reload();
              }}
            />
          ))}
        </ol>
        {canReport(task, me) && task.status !== 'done' && (
          <LogComposer task={task} me={me} onSent={logs.reload} />
        )}
      </section>
    </div>
  );
}

function LogItem({
  log,
  task,
  author,
  name,
  report,
  canReopenIt,
  canResolveIt,
  onChanged,
}: {
  log: TaskLog;
  task: Task;
  author: MemberView | undefined;
  name: string;
  report: Awaited<ReturnType<typeof api.taskReport>> | null | undefined;
  canReopenIt: boolean;
  canResolveIt: boolean;
  onChanged: () => void;
}) {
  const [answering, setAnswering] = useState(false);
  const resolve = useAction();
  const open = task.blocked?.log === log.id;
  const [reading, setReading] = useState(false);
  const [reopening, setReopening] = useState(false);
  const close = log.kind === 'close';
  const summary =
    close && report
      ? (parseSections(report.format as DocFormat, report.body).find((s) => s.key === 'summary')
          ?.text ?? '')
      : '';
  const files = close && report ? parseAttachments(report.attachments) : [];
  return (
    <li
      className={`flex gap-2.5 ${close ? 'rounded-control border border-st-online bg-bg p-3' : ''} ${log.kind === 'reopen' || (isBlocked(log) && open) ? 'rounded-control border border-warning p-3' : ''}`}
    >
      {author ? <Avatar member={author} size={22} /> : <span className="size-5.5" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-bold text-fg">{name}</span>
          <Badge tone={close ? 'primary' : isBlocked(log) && open ? 'alert' : 'neutral'}>
            {t(KIND_LABEL[log.kind])}
          </Badge>
          {log.percent !== null && <span>{log.percent}%</span>}
          <span>{formatTime(log.at)}</span>
        </p>
        {log.text && (
          <Markdown variant="chat" className="text-sm">
            {log.text}
          </Markdown>
        )}
        {close && report && (
          <div className="flex flex-col gap-2">
            {summary && <p className="text-sm">{summary}</p>}
            {files.map((a, i) => (
              <AttachmentCard key={i} a={a} author={author} createdAt={log.at} />
            ))}
            <div className="flex gap-3">
              <LinkButton aria-expanded={reading} onClick={() => setReading((x) => !x)}>
                {reading ? t('tdetail.report.hide') : t('tdetail.report.read')}
              </LinkButton>
              {canReopenIt && (
                <LinkButton tone="muted" onClick={() => setReopening(true)}>
                  {t('tdetail.reopen')}
                </LinkButton>
              )}
            </div>
            {reading && (
              <DocView format={report.format as DocFormat} body={report.body} className="text-sm" />
            )}
          </div>
        )}
        {isBlocked(log) && open && (canAnswer(task) || canResolveIt) && (
          <div className="flex flex-col gap-1">
            {canResolveIt && !answering && (
              <div>
                <LinkButton
                  className="text-xs"
                  disabled={resolve.busy}
                  onClick={async () => {
                    if (
                      await resolve.attempt(() =>
                        api.resolveTaskBlocked(task.team, task.id, log.id, ''),
                      )
                    )
                      onChanged();
                  }}
                >
                  {t('tdetail.resolve')}
                </LinkButton>
              </div>
            )}
            <ErrorText message={resolve.error} />
          </div>
        )}
        {isBlocked(log) && open && canAnswer(task) && (
          <div>
            {answering ? (
              <AnswerBox
                task={task}
                onDone={() => {
                  setAnswering(false);
                  onChanged();
                }}
              />
            ) : (
              <LinkButton className="text-xs" onClick={() => setAnswering(true)}>
                {t('tdetail.answer')}
              </LinkButton>
            )}
          </div>
        )}
      </div>
      {reopening && (
        <ReopenDialog
          task={task}
          onClose={() => setReopening(false)}
          onDone={() => {
            setReopening(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function AnswerBox({ task, onDone }: { task: Task; onDone: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, attempt } = useAction();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <TextInput
          size="sm"
          autoFocus
          className="min-w-0 flex-1"
          aria-label={t('tdetail.answer')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || !text.trim()}
          onClick={async () => {
            if (await attempt(() => api.addTaskLog(task.team, task.id, 'answer', text, null)))
              onDone();
          }}
        >
          {t('tdetail.answer.send')}
        </Button>
      </div>
      <ErrorText message={error} />
    </div>
  );
}

function LogComposer({ task, me, onSent }: { task: Task; me: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [percent, setPercent] = useState('');
  const { busy, error, attempt } = useAction();
  const pct = percent.trim() === '' ? null : Math.max(0, Math.min(100, Number(percent)));
  const send = async (kind: 'progress' | 'blocked') => {
    if (
      await attempt(() =>
        api.addTaskLog(task.team, task.id, kind, text, kind === 'progress' ? pct : null),
      )
    ) {
      setText('');
      setPercent('');
      onSent();
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-control border border-line p-2">
      <TextArea
        rows={2}
        aria-label={t('tdetail.composer')}
        placeholder={t('tdetail.composer.placeholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canReport(task, me) && (
          <>
            <TextInput
              size="sm"
              type="number"
              min={0}
              max={100}
              className="w-20"
              aria-label={t('tdetail.percent.label')}
              placeholder="%"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
            <Button
              size="sm"
              variant="soft"
              disabled={busy || !text.trim()}
              onClick={() => void send('progress')}
            >
              {t('tdetail.progress')}
            </Button>
          </>
        )}
        {canBlock(task, me) && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !text.trim()}
            onClick={() => void send('blocked')}
          >
            {t('tdetail.question')}
          </Button>
        )}
      </div>
      {canBlock(task, me) && task.team !== 'private' && (
        <p className="text-xs text-muted">{t('tdetail.blocked.hint')}</p>
      )}
      <ErrorText message={error} />
    </div>
  );
}

function ReopenDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, attempt } = useAction();
  return (
    <Dialog
      title={t('tdetail.reopen.title', { title: task.title })}
      onClose={onClose}
      onSubmit={async () => {
        setTried(true);
        if (!text.trim()) return;
        if (await attempt(() => api.reopenTask(task.team, task.id, text))) onDone();
      }}
      dirty={Boolean(text)}
    >
      <Field
        label={t('tdetail.reopen.reason')}
        required
        error={tried && !text.trim() ? t('field.required') : null}
      >
        <TextArea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <p className="text-xs text-muted">{t('tdetail.reopen.hint')}</p>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy}>
          {t('tdetail.reopen')}
        </Button>
      </div>
    </Dialog>
  );
}
