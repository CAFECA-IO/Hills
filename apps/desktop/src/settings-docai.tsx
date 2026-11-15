/**
 * 設定 › AI 協助 › 文件理解（ui-spec v0.49，D68；technical-design §16.20）。
 */
import { useState } from 'react';
import { api, type DocAiModel, type DocComponent } from './api';
import { refreshDocAi, useDocAi } from './docai';
import { refreshKbAsk, useKbAskStatus } from './kbask';
import { t, type MessageKey } from './i18n';
import { formatBytes } from './share';
import {
  Button,
  Card,
  ConfirmButton,
  ErrorText,
  OptionTile,
  ProgressBar,
  ScopeTag,
  Switch,
  useAction,
} from './ui';

const MODELS: DocAiModel[] = ['e5-small', 'bge-m3'];

export function ComponentRow({ c, onRetry }: { c: DocComponent; onRetry: () => void }) {
  const pct = c.total > 0 ? Math.round((Math.min(c.done, c.total) / c.total) * 100) : 0;
  const name = t(`docai.comp.${c.id}` as MessageKey);
  return (
    <li className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        <span className="text-xs text-muted">{formatBytes(c.size)}</span>
      </div>
      {c.state === 'downloading' && <ProgressBar size="sm" value={pct} label={name} />}
      <div className="flex items-center gap-2 text-xs">
        {c.state === 'failed' ? (
          <>
            <span className="min-w-0 flex-1 text-warning">
              {t('docai.comp.failed', { error: c.error ?? '' })}
            </span>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {t('docai.retry')}
            </Button>
          </>
        ) : (
          <span className="text-muted">
            {c.state === 'downloading'
              ? t('docai.comp.downloading', { pct })
              : t(`docai.comp.${c.state}`)}
          </span>
        )}
      </div>
    </li>
  );
}

export function DocAiCard() {
  const { status, queued, running } = useDocAi();
  const { error, attempt } = useAction();
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const run = (fn: () => Promise<unknown>) =>
    void attempt(async () => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
        await refreshDocAi();
      }
    });
  const indexed = Object.values(status.files).filter((f) => f.status === 'ready').length;
  const waiting = queued.length + (running ? 1 : 0);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-medium">{t('docai.title')}</h2>
          <ScopeTag scope="device" label={t('settings.scope.device')} />
        </div>
        <p className="text-sm text-muted">{t('docai.intro')}</p>
      </div>
      {!status.supported ? (
        <p className="text-sm text-muted">{t('docai.unsupported')}</p>
      ) : (
        <>
          <Switch
            checked={status.enabled}
            disabled={busy}
            onChange={(on) =>
              run(() => (on ? api.docaiEnable(status.model) : api.docaiDisable(false)))
            }
            label={t('docai.enable')}
            description={status.enabled ? undefined : t('docai.enableHint')}
          />
          <OptionTile
            label={t('docai.model')}
            columns={2}
            value={status.model}
            onChange={(m) => {
              if (m !== status.model) run(() => api.docaiEnable(m));
            }}
            options={MODELS.map((m) => ({
              value: m,
              title: t(`docai.model.${m}`),
              description: t(`docai.model.${m}.desc`),
              disabled: busy,
            }))}
          />
          {status.enabled && (
            <>
              <p className="text-xs text-muted">{t('docai.switchModel')}</p>
              <ul className="flex flex-col divide-y divide-line">
                {status.components.map((c) => (
                  <ComponentRow
                    key={c.id}
                    c={c}
                    onRetry={() => run(() => api.docaiEnable(status.model))}
                  />
                ))}
              </ul>
              {status.ready && (
                <p className="text-sm">
                  {waiting > 0
                    ? t('docai.summaryQueued', {
                        files: indexed,
                        chunks: status.totalChunks,
                        queued: waiting,
                      })
                    : t('docai.summaryKb', {
                        items: status.kbItems ?? 0,
                        files: indexed,
                        chunks: status.totalChunks,
                      })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {status.ready && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(() => api.docaiRebuild())}
                  >
                    {t('docai.rebuild')}
                  </Button>
                )}
                <ConfirmButton
                  label={t('docai.purge')}
                  message={t('docai.purge.confirm')}
                  onConfirm={() => run(() => api.docaiDisable(true))}
                />
              </div>
            </>
          )}
          <p className="text-xs text-muted">{t('docai.later')}</p>
        </>
      )}
      <ErrorText message={error} />
    </Card>
  );
}

/** 設定 › AI 協助 › 問知識庫（ui-spec v0.51，D70；technical-design §16.21）。 */
export function KbAskCard() {
  const status = useKbAskStatus();
  const docai = useDocAi().status;
  const { error, attempt } = useAction();
  const [busy, setBusy] = useState(false);
  if (!status || !docai?.supported) return null;
  const run = (fn: () => Promise<unknown>) =>
    void attempt(async () => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
        await Promise.all([refreshKbAsk(), refreshDocAi()]);
      }
    });
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 font-medium">{t('kbask.title')}</h2>
          <ScopeTag scope="device" label={t('settings.scope.device')} />
        </div>
        <p className="text-sm text-muted">{t('kbask.intro')}</p>
      </div>
      <Switch
        checked={status.enabled}
        disabled={busy}
        onChange={(on) => run(() => (on ? api.kbaskEnable() : api.kbaskDisable(false)))}
        label={t('kbask.enable')}
        description={status.enabled ? undefined : t('kbask.enableHint')}
      />
      {status.memoryLow && <p className="text-sm text-warning">{t('kbask.memoryLow')}</p>}
      {status.enabled && (
        <>
          <ul className="flex flex-col divide-y divide-line">
            {status.components.map((c) => (
              <ComponentRow key={c.id} c={c} onRetry={() => run(() => api.kbaskEnable())} />
            ))}
          </ul>
          {status.ready && <p className="text-sm">{t('kbask.ready')}</p>}
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              label={t('kbask.purge')}
              message={t('kbask.purge.confirm')}
              onConfirm={() => run(() => api.kbaskDisable(true))}
            />
          </div>
        </>
      )}
      <ErrorText message={error} />
    </Card>
  );
}
