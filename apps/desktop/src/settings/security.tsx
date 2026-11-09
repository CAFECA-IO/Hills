/** 設定 › 安全與存取（ui-spec「設定」v0.37；D41）：我的裝置、組織連線碼、根金鑰備份。 */
import { useState } from 'react';
import { api, type AppInfo, type Code } from '../api';
import { useLoad } from '../hooks';
import { formatTime, t } from '../i18n';
import { BackupForm } from '../onboarding';
import {
  Button,
  Card,
  Checkbox,
  CodeBox,
  ConfirmButton,
  ErrorText,
  ScopeTag,
  useAction,
} from '../ui';
import { readFlag, writeFlag } from './model';

export function SecurityGroup({ info }: { info: AppInfo }) {
  return (
    <>
      <DevicesCard />
      <OrgCodeCard />
      {info.hasOrgRoot && (
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 id="settings-backup" className="flex-1 font-medium">
              {t('settings.backup')}
            </h2>
            <ScopeTag scope="org" label={t('settings.scope.org')} />
          </div>
          <BackupForm onDone={() => writeFlag('backup')} />
        </Card>
      )}
    </>
  );
}

function DevicesCard() {
  const devices = useLoad(api.devices, ['roster', 'device-added']);
  const { error, attempt } = useAction();
  const [single, setSingle] = useState(readFlag('singleDevice'));
  const list = devices.data ?? [];
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="settings-devices" className="flex-1 font-medium">
          {t('settings.devices')}
        </h2>
        <ScopeTag scope="me" label={t('settings.scope.me')} />
      </div>
      <p className="text-sm text-muted">{t('settings.devices.add')}</p>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-2">
            <span>
              {d.name}
              {d.thisDevice && (
                <span className="ml-2 text-xs text-muted">{t('settings.thisDevice')}</span>
              )}
              <span className="block text-xs text-muted">{formatTime(d.issuedAt)}</span>
            </span>
            {!d.thisDevice && (
              <ConfirmButton
                label={t('settings.revokeDevice')}
                message={t('settings.revokeDevice.confirm', { name: d.name })}
                onConfirm={async () => {
                  if (await attempt(() => api.revokeDevice(d.id))) devices.reload();
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {devices.data && list.length <= 1 && (
        <Checkbox
          label={t('progress.singleDevice')}
          checked={single}
          onChange={(e) => {
            setSingle(e.target.checked);
            writeFlag('singleDevice', e.target.checked);
          }}
        />
      )}
      <ErrorText message={error ?? devices.error} />
    </Card>
  );
}

function OrgCodeCard() {
  const [code, setCode] = useState<Code | null>(null);
  const { error, run } = useAction();
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id="settings-orgCode" className="flex-1 font-medium">
          {t('settings.orgCode')}
        </h2>
        <ScopeTag scope="org" label={t('settings.scope.org')} />
      </div>
      <p className="text-sm text-muted">{t('settings.orgCode.desc')}</p>
      {code ? (
        <CodeBox code={code.code} qrSvg={code.qrSvg} />
      ) : (
        <div>
          <Button
            variant="secondary"
            onClick={async () => {
              const c = await run(api.orgCode);
              if (c) setCode(c);
            }}
          >
            {t('settings.show')}
          </Button>
        </div>
      )}
      <ErrorText message={error} />
    </Card>
  );
}
