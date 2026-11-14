/**
 * 知識庫搜尋的「PDF 內容」結果（ui-spec v0.49，D68）：最多 5 筆；
 * 出處是知識時開啟該知識，其他出處前往「檔案」並選取該檔。
 */
import { api } from './api';
import { pageLabel, useContentHits, useDocAi } from './docai';
import { snippetAround } from './docai-utils';
import { SourceIcon } from './files';
import { useLoad } from './hooks';
import { t } from './i18n';
import { navigate } from './nav';
import { Card, ListButton } from './ui';

export function KbPdfHits({ q, onOpenItem }: { q: string; onOpenItem: (key: string) => void }) {
  const { status, running, queued } = useDocAi();
  const ready = status?.ready ?? false;
  const hits = useContentHits(q, ready);
  const files = useLoad(api.listFiles, ['message', 'doc', 'convs', 'org']);
  if (!ready || q.trim().length < 2) return null;
  const byKey = new Map((files.data ?? []).map((f) => [f.key, f]));
  const shown = hits.filter((h) => byKey.has(h.fileKey)).slice(0, 5);
  if (shown.length === 0) return null;
  const pending = queued.length + (running ? 1 : 0);
  const done = Object.keys(status?.files ?? {}).length;
  return (
    <Card className="flex flex-col gap-1 p-3">
      <h2 className="flex items-center gap-2 px-2 text-sm font-bold">
        {t('docai.kbHits')}
        {pending > 0 && (
          <span className="text-xs font-normal text-muted">
            {t('docai.kbBuilding', { done, total: done + pending })}
          </span>
        )}
      </h2>
      <ul className="flex flex-col">
        {shown.map((h, i) => {
          const f = byKey.get(h.fileKey)!;
          const kb = f.sources.find((s) => s.kind === 'kb');
          return (
            <li key={`${h.fileKey}-${i}`}>
              <ListButton
                className="w-full gap-2"
                onClick={() =>
                  kb && kb.kind === 'kb'
                    ? onOpenItem(kb.kbKey)
                    : navigate({ page: 'files', fileKey: h.fileKey })
                }
              >
                <SourceIcon kind={(kb ?? f.sources[0]!).kind} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">{h.name}</span>
                  <span className="truncate text-xs text-muted">
                    {pageLabel(h)}
                    {h.heading.length > 0 && ` · ${h.heading.join(' › ')}`}
                  </span>
                  <span className="truncate text-xs text-muted">{snippetAround(h.snippet, q)}</span>
                </span>
              </ListButton>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
