/** 設定 › 我的節奏（ui-spec「設定」v0.37，D56、D57）：語言、Scrum 提醒、工作時段、通知。 */
import { useEffect, useState } from 'react';
import { api, type MemberProfile, type NotifyPrefs } from '../api';
import { useLoad } from '../hooks';
import { getLocale, LOCALES, setLocale, t, type MessageKey } from '../i18n';
import { emptyProfile, validHours } from '../profile-utils';
import { Button, Chip, ErrorText, GlassPanel, Select, Switch, TextInput, useAction } from '../ui';
import { writeFlag } from './model';

const scope = (s: 'device' | 'me' | 'org') => ({ scope: s, label: t(`settings.scope.${s}`) });

export function RhythmGroup() {
  useEffect(() => writeFlag('notify'), []);
  return (
    <>
      <GlassPanel id="settings-language" title={t('settings.language')} scope={scope('device')}>
        <Select
          aria-label={t('settings.language')}
          value={getLocale()}
          onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`lang.${l}` as MessageKey)}
            </option>
          ))}
        </Select>
      </GlassPanel>
      <ScrumReminderPanel />
      <HoursPanel />
      <NotifyPanel />
    </>
  );
}

/** 個人的 Scrum 提醒時間（只存本機，technical-design §16.12）。 */
function ScrumReminderPanel() {
  const r = useLoad(api.scrumReminder, ['org']);
  const [value, setValue] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const current = value ?? r.data?.mine ?? '';
  return (
    <GlassPanel id="settings-scrum" title={t('settings.scrumReminder')} scope={scope('device')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <TextInput
            aria-label={t('settings.scrumReminder')}
            type="time"
            value={current}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={busy || value === null}
            onClick={async () => {
              if (await attempt(() => api.setMyScrumReminder(current || null))) {
                setValue(null);
                r.reload();
              }
            }}
          >
            {t('common.save')}
          </Button>
        </div>
        <p className="text-xs text-muted">
          {t('settings.scrumReminder.hint', { time: r.data?.org ?? '17:30' })}
        </p>
        <ErrorText message={error ?? r.error} />
      </div>
    </GlassPanel>
  );
}

function HoursPanel() {
  const p = useLoad(api.myProfile, ['doc']);
  if (!p.data) return <ErrorText message={p.error} />;
  return <HoursForm key={p.data.updatedAt} initial={p.data} />;
}

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function HoursForm({ initial }: { initial: MemberProfile }) {
  const [hours, setHours] = useState(initial.workHours);
  const [saved, setSaved] = useState(false);
  const { busy, error, attempt } = useAction();
  const invalid = !validHours(hours);
  const set = (h: typeof hours) => {
    setHours(h);
    setSaved(false);
  };
  return (
    <GlassPanel id="settings-hours" title={t('hours.title')} scope={scope('me')}>
      <div className="flex flex-col gap-3">
        <div role="group" aria-label={t('hours.days')} className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => (
            <Chip
              key={d}
              selected={hours.days.includes(d)}
              onClick={() =>
                set({
                  ...hours,
                  days: hours.days.includes(d)
                    ? hours.days.filter((x) => x !== d)
                    : [...hours.days, d].sort(),
                })
              }
            >
              {t(`hours.day.${d}`)}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('hours.start')}
            <TextInput
              type="time"
              value={hours.start}
              onChange={(e) => set({ ...hours, start: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('hours.end')}
            <TextInput
              type="time"
              value={hours.end}
              onChange={(e) => set({ ...hours, end: e.target.value })}
            />
          </label>
          <Button
            variant="secondary"
            disabled={busy || invalid}
            onClick={async () => {
              const next = { ...emptyProfile(), ...initial, workHours: hours };
              if (await attempt(() => api.setMyProfile(next))) {
                writeFlag('hours');
                setSaved(true);
              }
            }}
          >
            {t('common.save')}
          </Button>
          {saved && (
            <span role="status" className="text-sm text-st-online-text">
              {t('profile.saved')}
            </span>
          )}
        </div>
        {invalid && <ErrorText message={t('hours.invalid')} />}
        <p className="text-xs text-muted">{t('hours.hint')}</p>
        <ErrorText message={error} />
      </div>
    </GlassPanel>
  );
}

const NOTIFY_KEYS: (keyof NotifyPrefs)[] = ['messages', 'assigned', 'blockers', 'scrumReminder'];

function NotifyPanel() {
  const prefs = useLoad(api.notifyPrefs, ['doc']);
  const { error, attempt } = useAction();
  const [local, setLocal] = useState<NotifyPrefs | null>(null);
  const current = local ?? prefs.data;
  return (
    <GlassPanel id="settings-notify" title={t('notify.title')} scope={scope('me')}>
      <div className="flex flex-col gap-3">
        {current &&
          NOTIFY_KEYS.map((k) => (
            <Switch
              key={k}
              label={t(`notify.${k}`)}
              checked={current[k]}
              onChange={async (on) => {
                const next = { ...current, [k]: on };
                setLocal(next);
                await attempt(() => api.setNotifyPrefs(next));
              }}
            />
          ))}
        <p className="text-xs text-muted">{t('notify.security')}</p>
        <ErrorText message={error ?? prefs.error} />
      </div>
    </GlassPanel>
  );
}
