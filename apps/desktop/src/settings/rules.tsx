/** 設定 › 團隊規則（ui-spec「設定」v0.37）：組織名稱、辦公室與午休、Scrum 預設提醒、公司方向、偏離門檻。 */
import { useState } from 'react';
import { api, type AppInfo, type OfficeView, type Overview } from '../api';
import { DirectionsCard, DriftRulesCard } from '../directions-settings';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import {
  Button,
  Card,
  ConfirmButton,
  ErrorText,
  Field,
  ScopeTag,
  TextInput,
  useAction,
} from '../ui';

export function RulesGroup({ info, overview }: { info: AppInfo; overview: Overview }) {
  if (!info.isAdmin) return <RulesReadonly overview={overview} />;
  return (
    <>
      <OrgNameCard orgName={overview.orgName} />
      <div id="settings-offices">
        <OfficesCard overview={overview} />
      </div>
      <div id="settings-orgScrum">
        <OrgScrumReminderCard />
      </div>
      <div id="settings-directions">
        <DirectionsCard />
      </div>
      <div id="settings-drift">
        <DriftRulesCard />
      </div>
    </>
  );
}

function OrgNameCard({ orgName }: { orgName: string }) {
  const [name, setName] = useState(orgName);
  const { busy, error, attempt } = useAction();
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex justify-end">
        <ScopeTag scope="org" label={t('settings.scope.org')} />
      </div>
      <div id="settings-orgName">
        <Field label={t('settings.orgName')} value={name} onChange={setName} />
      </div>
      <div>
        <Button
          disabled={busy || !name.trim() || name === orgName}
          onClick={() => void attempt(() => api.renameOrg(name))}
        >
          {t('common.save')}
        </Button>
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

/** 非管理者：看得到規則，沒有編輯控制。 */
function RulesReadonly({ overview }: { overview: Overview }) {
  const r = useLoad(api.scrumReminder, ['org']);
  const row = (label: string, value: string, id: string) => (
    <div id={`settings-${id}`} className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-right text-sm text-muted">{value}</span>
    </div>
  );
  const lunch = overview.lunchBreak;
  return (
    <Card className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('rules.readonly')}</p>
        <ScopeTag scope="org" label={t('settings.scope.org')} />
      </div>
      <div className="flex flex-col divide-y divide-line">
        {row(t('settings.orgName'), overview.orgName, 'orgName')}
        {row(
          t('offices.title'),
          overview.offices.map((o) => o.name).join('、') || t('rules.notSet'),
          'offices',
        )}
        {row(t('lunch.title'), lunch ? `${lunch.start}–${lunch.end}` : t('rules.notSet'), 'lunch')}
        {row(t('settings.orgScrumReminder'), r.data?.org ?? '—', 'orgScrum')}
      </div>
    </Card>
  );
}

function OfficesCard({ overview }: { overview: Overview }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState(overview.lunchBreak?.start ?? '12:00');
  const [end, setEnd] = useState(overview.lunchBreak?.end ?? '13:30');
  const { busy, error, attempt } = useAction();
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-bold">{t('offices.title')}</h2>
      <p className="text-sm text-muted">{t('offices.desc')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {overview.offices.map((o) => (
          <OfficeRow key={o.id} office={o} />
        ))}
        {overview.offices.length === 0 && (
          <li className="py-2 text-sm text-muted">{t('offices.empty')}</li>
        )}
      </ul>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field
            label={t('offices.new')}
            value={name}
            onChange={setName}
            placeholder={t('offices.new.placeholder')}
          />
        </div>
        <Button
          variant="soft"
          disabled={busy || !name.trim()}
          onClick={async () => {
            if (await attempt(() => api.upsertOffice(null, name))) setName('');
          }}
        >
          {t('offices.add')}
        </Button>
      </div>
      <h3 className="mt-2 font-bold">{t('lunch.title')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('lunch.start')}
          <TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('lunch.end')}
          <TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button
          variant="soft"
          disabled={busy}
          onClick={() => void attempt(() => api.setLunchBreak(start, end))}
        >
          {t('common.save')}
        </Button>
        {overview.lunchBreak && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void attempt(() => api.setLunchBreak('', ''))}
          >
            {t('lunch.clear')}
          </Button>
        )}
      </div>
      <ErrorText message={error} />
    </Card>
  );
}

function OfficeRow({ office }: { office: OfficeView }) {
  const [name, setName] = useState(office.name);
  const { busy, error, attempt } = useAction();
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <TextInput
        aria-label={t('offices.name')}
        className="min-w-40 flex-1"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !name.trim() || name === office.name}
        onClick={() => void attempt(() => api.upsertOffice(office.id, name))}
      >
        {t('offices.rename')}
      </Button>
      <ConfirmButton
        label={t('offices.remove')}
        message={t('offices.remove.confirm', { name: office.name })}
        onConfirm={async () => {
          await attempt(() => api.removeOffice(office.id));
        }}
      />
      <ErrorText message={error} />
    </li>
  );
}

/** 設定 › 組織「Scrum 預設提醒時間」（管理者）。 */
function OrgScrumReminderCard() {
  const r = useLoad(api.scrumReminder, ['org']);
  const [value, setValue] = useState<string | null>(null);
  const { busy, error, attempt } = useAction();
  const current = value ?? r.data?.org ?? '17:30';
  return (
    <Card className="flex flex-col gap-2">
      <label htmlFor="org-scrum-reminder" className="text-sm font-medium">
        {t('settings.orgScrumReminder')}
      </label>
      <div className="flex items-center gap-2">
        <TextInput
          id="org-scrum-reminder"
          type="time"
          required
          value={current}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={busy || value === null || !current}
          onClick={async () => {
            if (await attempt(() => api.setOrgScrumReminder(current))) setValue(null);
          }}
        >
          {t('common.save')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('settings.orgScrumReminder.hint')}</p>
      <ErrorText message={error ?? r.error} />
    </Card>
  );
}
