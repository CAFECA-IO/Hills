/** 設定 › 關於（ui-spec「設定」v0.37）。 */
import { api } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { Card } from '../ui';

export function AboutGroup() {
  return (
    <div id="settings-version">
      <VersionCard />
    </div>
  );
}

/** 版本號與建置 commit（ui-spec「設定 → 個人」v0.30），回報問題時附上。 */
function VersionCard() {
  const v = useLoad(api.appVersion, []);
  if (!v.data) return null;
  const text = v.data.commit ? `${v.data.version} (${v.data.commit})` : v.data.version;
  return (
    <Card className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium">{t('settings.version')}</span>
      <code className="text-sm text-muted select-all">{text}</code>
    </Card>
  );
}
