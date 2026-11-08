/** 設定 → 組織 →「公司方向」（ui-spec「目標 → 團隊」，D47；technical-design §16.14），只有管理者。 */
import { useState } from 'react';
import { api, type Direction } from './api';
import { useLoad } from './hooks';
import { t } from './i18n';
import {
  Button,
  Card,
  ConfirmButton,
  Dialog,
  EmptyState,
  ErrorText,
  Field,
  Select,
  TextInput,
  useAction,
} from './ui';

type Draft = { id: string | null; year: string; title: string };

export function DirectionsCard() {
  const data = useLoad(api.directions, ['doc', 'org']);
  const [editing, setEditing] = useState<Draft | null>(null);
  const { error, attempt } = useAction();
  const thisYear = new Date().getFullYear();
  const years = [String(thisYear), String(thisYear + 1)];
  const list = data.data?.directions ?? [];
  const byYear = [...new Set([...years, ...list.map((d) => d.year)])].sort();
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center">
        <h2 className="font-medium">{t('settings.directions.title')}</h2>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => setEditing({ id: null, year: years[1] ?? '', title: '' })}
        >
          {t('settings.directions.add')}
        </Button>
      </div>
      <p className="text-sm text-muted">{t('settings.directions.hint')}</p>
      {list.length === 0 && <EmptyState>{t('settings.directions.empty')}</EmptyState>}
      {byYear.map((y) => {
        const items = list.filter((d) => d.year === y);
        if (items.length === 0) return null;
        return (
          <div key={y} className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-level-year">{y}</span>
            {items.map((d: Direction) => (
              <div key={d.id} className="flex items-center gap-2 rounded-control bg-bg px-3 py-2">
                <span className="flex-1 truncate">{d.title}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ id: d.id, year: d.year, title: d.title })}
                >
                  {t('guide.team.edit')}
                </Button>
                <ConfirmButton
                  label={t('guide.team.delete')}
                  message={t('settings.directions.delete.confirm', { title: d.title })}
                  onConfirm={async () => {
                    if (await attempt(() => api.deleteDirection(d.id))) data.reload();
                  }}
                />
              </div>
            ))}
          </div>
        );
      })}
      <ErrorText message={error ?? data.error} />
      {editing && (
        <DirectionDialog
          initial={editing}
          years={byYear}
          keyResults={list.find((d) => d.id === editing.id)?.keyResults ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            data.reload();
          }}
        />
      )}
    </Card>
  );
}

function DirectionDialog({
  initial,
  years,
  keyResults,
  onClose,
  onSaved,
}: {
  initial: Draft;
  years: string[];
  keyResults: Direction['keyResults'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState(initial);
  const [titleError, setTitleError] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const save = async () => {
    if (!v.title.trim()) {
      setTitleError(t('field.required'));
      return;
    }
    const ok = await attempt(() =>
      api.saveDirection({ id: v.id, year: v.year, title: v.title.trim(), keyResults }),
    );
    if (ok) onSaved();
  };
  return (
    <Dialog
      title={v.id ? t('settings.directions.edit') : t('settings.directions.new')}
      onClose={onClose}
      onSubmit={save}
      dirty={JSON.stringify(v) !== JSON.stringify(initial)}
    >
      <Field label={t('settings.directions.year')}>
        <Select value={v.year} onChange={(e) => setV({ ...v, year: e.target.value })}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('settings.directions.titleField')} error={titleError} required>
        <TextInput
          autoFocus
          value={v.title}
          onChange={(e) => {
            setV({ ...v, title: e.target.value });
            setTitleError(null);
          }}
        />
      </Field>
      <ErrorText message={error} />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy}>
          {t('common.save')}
        </Button>
      </div>
    </Dialog>
  );
}
