/**
 * 匯出知識庫（ui-spec「知識庫 › 匯出 / 匯入」v0.55、technical-design §16.23，D74）：
 * 選範圍 → 選存放位置 → 逐則寫出 Markdown 與附件 → 最後寫 hills-kb.json → 摘要。
 */
import { useRef, useState } from 'react';
import { api, type KbSnapshot } from './api';
import { t } from './i18n';
import { MANIFEST, planExport } from './kb-export-utils';
import { decodeToMemory, parseAttachments } from './share';
import {
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  ErrorText,
  Field,
  ProgressBar,
  Select,
} from './ui';

const enc = new TextEncoder();
const pad = (n: number) => String(n).padStart(2, '0');

type Phase =
  | { kind: 'form' }
  | { kind: 'running'; done: number; total: number; current: string }
  | { kind: 'done'; folder: string; items: number; files: number; failed: string[] };

export function KbExport({
  data,
  org,
  nameOf,
  onClose,
}: {
  data: KbSnapshot;
  org: string;
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const cats = data.categories.filter((c) => c.resolved === c.id);
  const [category, setCategory] = useState('');
  const [withFiles, setWithFiles] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);

  const write = async (token: string, path: string, bytes: Uint8Array) => {
    await api.writePartial(token, path, 0, bytes);
    await api.finishDownload(token, path, bytes.length);
  };

  const run = async () => {
    setError(null);
    cancel.current = false;
    try {
      const target = await api.saveTargetFolder();
      if (!target) return;
      const d = new Date();
      const dir = `${t('kbExport.folder')} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
      const plan = planExport(data, {
        category: category || null,
        withAttachments: withFiles,
        org,
        dir,
        now: Date.now(),
        nameOf,
      });
      const total = plan.docs.length + plan.attachments.length;
      let done = 0;
      const failed: string[] = [];
      for (const doc of plan.docs) {
        if (cancel.current) break;
        setPhase({ kind: 'running', done, total, current: doc.item.title });
        await write(target.token, doc.path, enc.encode(doc.text));
        done++;
      }
      let files = 0;
      for (const a of plan.attachments) {
        if (cancel.current) break;
        setPhase({ kind: 'running', done, total, current: a.path.split('/').pop() ?? '' });
        try {
          const att = parseAttachments([a.attachment])[0];
          if (!att || att.type !== 'file') throw new Error('not a file');
          await write(target.token, a.path, await decodeToMemory(att.manifest, att.fileKey));
          files++;
        } catch (e) {
          failed.push(`${a.path.split('/').pop()}：${e instanceof Error ? e.message : String(e)}`);
          // 寫不出的附件從 manifest 拿掉，匯入時才不會找不到
          const it = plan.manifest.items.find((i) => i.key === a.item.key);
          if (it) it.attachments = it.attachments.filter((x) => `${dir}/${x.path}` !== a.path);
        }
        done++;
      }
      // manifest 最後寫：中途取消時資料夾不會被當成完整的匯出
      if (!cancel.current)
        await write(
          target.token,
          `${dir}/${MANIFEST}`,
          enc.encode(JSON.stringify(plan.manifest, null, 2)),
        );
      setPhase({
        kind: 'done',
        folder: `${target.name}/${dir}`,
        items: plan.docs.length,
        files,
        failed,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: 'form' });
    }
  };

  return (
    <Dialog
      title={t('kbExport.title')}
      width="md"
      onClose={phase.kind === 'running' ? () => undefined : onClose}
      footer={
        phase.kind === 'form' ? (
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void run()}>{t('kbExport.submit')}</Button>
          </DialogFooter>
        ) : phase.kind === 'running' ? (
          <DialogFooter>
            <Button variant="secondary" onClick={() => (cancel.current = true)}>
              {t('kbImport.stop')}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button onClick={onClose}>{t('kbImport.done')}</Button>
          </DialogFooter>
        )
      }
    >
      {phase.kind === 'form' && (
        <div className="flex flex-col gap-3 text-sm">
          <Field label={t('kbExport.scope')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('kbExport.scope.all')}</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox
            label={t('kbExport.withFiles')}
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
          />
          <p role="note" className="rounded-control bg-bg px-3 py-2 text-xs">
            {t('kbExport.plain')}
          </p>
        </div>
      )}
      {phase.kind === 'running' && (
        <div className="flex flex-col gap-2 py-4">
          <ProgressBar
            value={phase.total ? Math.round((phase.done / phase.total) * 100) : 100}
            label={t('kbExport.running')}
          />
          <p className="text-sm text-muted">
            {t('kbImport.runningN', { done: phase.done, total: phase.total, name: phase.current })}
          </p>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">
            {t('kbExport.summary', {
              items: phase.items,
              files: phase.files,
              folder: phase.folder,
            })}
          </p>
          {phase.failed.length > 0 && (
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-muted">
              {phase.failed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText message={error} />
    </Dialog>
  );
}
