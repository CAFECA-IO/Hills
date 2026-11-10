/**
 * 結案對話框（ui-spec「任務 → 執行紀錄與結案」v0.35 / v0.41，D53）：
 * hills-doc/1 結案報告（Markdown / HTML）、完成條件逐條對照、附件上傳（小組成員可下載）。
 */
import { useState, useSyncExternalStore } from 'react';
import { api, isPrivateTask, type CriterionResult, type Task } from './api';
import { AttachMenu, AttachmentCard, UploadQueue } from './attachments';
import {
  missingRequired,
  parseSections,
  sanitizeHtml,
  sectionLabel,
  templateFor,
  type DocFormat,
} from './doc-spec';
import { t } from './i18n';
import { taskAttachments, taskTarget, uploads } from './share';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorText,
  IconButton,
  MarkdownEditor,
  SegmentedControl,
  TextInput,
  useAction,
} from './ui';

export function TaskCloseDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  /** 結案成功（呼叫端顯示 Toast） */
  onDone?: () => void;
}) {
  const [format, setFormat] = useState<DocFormat>('markdown');
  const [body, setBody] = useState(() => templateFor('report', 'markdown'));
  const [criteria, setCriteria] = useState<CriterionResult[]>(() =>
    task.acceptance.map((c) => ({ id: c.id, met: true, note: '' })),
  );
  const [tried, setTried] = useState(false);
  const { busy, error, attempt } = useAction();
  const target = taskTarget(task.team, task.id);
  // 上傳中的工作與已完成的附件（share.ts，記憶體）
  const jobs = useSyncExternalStore(uploads.subscribe, uploads.get).filter(
    (j) => j.conv === target,
  );
  const attachments = useSyncExternalStore(uploads.subscribe, () => taskAttachments.get(target));
  const hasCriteria = task.acceptance.length > 0;
  const sections = parseSections(format, body);
  const lacking = missingRequired('report', sections, hasCriteria);
  const untouched = sections.some(
    (s) => s.key === 'summary' && s.text.trim() === t('doc.hint.summary'),
  );
  const uploading = jobs.length > 0;
  const submit = async () => {
    setTried(true);
    if (lacking.length > 0 || untouched || uploading) return;
    const ok = await attempt(() =>
      api.closeTask(task.team, task.id, {
        format,
        body: format === 'html' ? sanitizeHtml(body) : body,
        criteria: criteria.map((c) => ({ ...c, note: c.note?.trim() || null })),
        attachments,
      }),
    );
    if (ok) {
      taskAttachments.clear(target);
      onDone?.();
      onClose();
    }
  };
  return (
    <Dialog
      title={t('close.title', { title: task.title })}
      onClose={onClose}
      onSubmit={() => void submit()}
      dirty
      width="lg"
    >
      <div className="flex items-center gap-3">
        <SegmentedControl
          label={t('close.format')}
          value={format}
          onChange={(f) => {
            const fresh = body === templateFor('report', format) || !body.trim();
            setFormat(f);
            if (fresh) setBody(templateFor('report', f));
          }}
          options={[
            { value: 'markdown', label: 'Markdown' },
            { value: 'html', label: 'HTML' },
          ]}
        />
        <span className="text-xs text-muted">{t('close.spec')}</span>
      </div>
      <MarkdownEditor
        label={t('close.report')}
        value={body}
        onChange={setBody}
        rows={12}
        invalid={tried && (lacking.length > 0 || untouched)}
      />
      {tried && (lacking.length > 0 || untouched) && (
        <p role="alert" className="text-xs text-danger">
          {lacking.length > 0
            ? t('close.missing', { keys: lacking.map(sectionLabel).join('、') })
            : t('close.untouched')}
        </p>
      )}
      {hasCriteria && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('close.criteria')}</legend>
          {task.acceptance.map((c, i) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3">
              <Checkbox
                label={c.text}
                checked={criteria[i]?.met ?? false}
                onChange={(e) =>
                  setCriteria(
                    criteria.map((x, j) => (j === i ? { ...x, met: e.target.checked } : x)),
                  )
                }
                className="min-w-0 flex-1"
              />
              <TextInput
                size="sm"
                className="w-56"
                maxLength={200}
                aria-label={t('close.note', { text: c.text })}
                placeholder={t('close.note.placeholder')}
                value={criteria[i]?.note ?? ''}
                onChange={(e) =>
                  setCriteria(
                    criteria.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                  )
                }
              />
            </div>
          ))}
        </fieldset>
      )}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('close.attachments')}</span>
          <AttachMenu conv={target} />
          <span className="text-xs text-muted">
            {isPrivateTask(task) ? t('close.attachments.private') : t('close.attachments.team')}
          </span>
        </div>
        <UploadQueue conv={target} />
        {attachments.length > 0 && (
          <ul className="flex flex-col gap-2">
            {attachments.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <AttachmentCard a={a} author={undefined} createdAt={task.updatedAt} />
                <IconButton
                  size="sm"
                  label={t('close.attachments.remove')}
                  onClick={() => taskAttachments.remove(target, i)}
                >
                  ×
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ErrorText message={error} />
      <div className="flex items-center justify-end gap-2">
        {uploading && <span className="text-xs text-muted">{t('close.uploading')}</span>}
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy} disabled={uploading}>
          {t('close.submit')}
        </Button>
      </div>
    </Dialog>
  );
}
