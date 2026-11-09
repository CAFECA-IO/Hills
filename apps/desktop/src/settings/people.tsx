/** 設定 › 人與小組（ui-spec「設定」v0.37；D41、D49）：待核准、小組、成員。 */
import { useState } from 'react';
import { api, type AppInfo, type JoinRequestView, type MemberView, type Overview } from '../api';
import { useLoad } from '../hooks';
import { formatTime, t } from '../i18n';
import { TeamsCard } from '../teams-settings';
import {
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  EmptyState,
  ErrorText,
  ScopeTag,
  Select,
  useAction,
} from '../ui';

export function PeopleGroup({
  info,
  members,
  overview,
}: {
  info: AppInfo;
  members: MemberView[];
  overview: Overview | null;
}) {
  const joins = useLoad(api.pendingJoins, ['joins', 'roster']);
  const { error, attempt } = useAction();
  const leads = overview?.teams.some((tm) => tm.leads.includes(info.memberId ?? '')) ?? false;
  if (!info.isAdmin) {
    // 不是管理者的負責人只看到自己負責的小組（D49）
    return leads ? (
      <TeamsCard members={members} isAdmin={false} />
    ) : (
      <Card>
        <p className="text-sm text-muted">{t('members.adminOnly')}</p>
      </Card>
    );
  }
  return (
    <>
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id="settings-joins" className="flex-1 font-medium">
            {t('joins.title')}
          </h2>
          <ScopeTag scope="org" label={t('settings.scope.org')} />
        </div>
        <p className="text-sm text-muted">{t('joins.desc')}</p>
        {(joins.data ?? []).length === 0 && (
          <EmptyState art="team" loading={joins.data === null}>
            {t('joins.empty')}
          </EmptyState>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {(joins.data ?? []).map((j) => (
            <JoinRow key={j.device} join={j} overview={overview} onDone={joins.reload} />
          ))}
        </ul>
        <ErrorText message={joins.error} />
      </Card>
      <TeamsCard members={members} isAdmin />
      <Card className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 id="settings-members" className="flex-1 font-medium">
            {t('members.title')}
          </h2>
          <ScopeTag scope="org" label={t('settings.scope.org')} />
        </div>
        <ul className="flex flex-col divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {m.name}
                {m.isMe && <span className="text-muted">{t('team.me')}</span>}
                {m.rosterName !== m.name && (
                  <span className="block text-xs text-muted">
                    {t('members.roster', { name: m.rosterName })}
                  </span>
                )}
                {m.isAdmin && (
                  <span className="ml-2 rounded-control border border-line px-1 text-xs text-muted">
                    {t('team.admin')}
                  </span>
                )}
              </span>
              {!m.isMe && (
                <ConfirmButton
                  label={t('members.revoke')}
                  message={t('members.revoke.confirm', { name: m.name })}
                  onConfirm={async () => {
                    await attempt(() => api.revokeMember(m.id));
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </Card>
      <ErrorText message={error} />
    </>
  );
}

/** 一筆待核准申請：加入時選擇角色與小組；還原沿用原角色（ui-spec「設定」D41 補充）。 */
function JoinRow({
  join,
  overview,
  onDone,
}: {
  join: JoinRequestView;
  overview: Overview | null;
  onDone: () => void;
}) {
  const [admin, setAdmin] = useState(false);
  const teams = overview?.teams ?? [];
  const [team, setTeam] = useState<string>('');
  const { busy, error, attempt } = useAction();
  const recover = join.kind === 'recover';
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {t(recover ? 'joins.kind.recover' : 'joins.kind.join')} ·{' '}
          {join.handle ? `@${join.handle}` : join.accountShort}
        </span>
        <span className="text-xs text-muted">{formatTime(join.receivedAt)}</span>
      </div>
      <span className="text-sm text-muted">
        {t('joins.detail', {
          name: join.name || '—',
          device: join.deviceName,
          account: join.accountShort,
        })}
      </span>
      {recover ? (
        <p className="text-sm">{t('joins.recoverHint')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            {t('joins.asAdmin')}
          </label>
          {teams.length > 0 && (
            <label className="flex items-center gap-2">
              {t('joins.team')}
              <Select size="sm" value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">{t('joins.team.default')}</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            if (await attempt(() => api.approveJoin(join.device, admin, team ? [team] : []))) {
              onDone();
            }
          }}
        >
          {t('joins.approve')}
        </Button>
        <ConfirmButton
          label={t('joins.reject')}
          message={t('joins.reject.confirm')}
          onConfirm={async () => {
            if (await attempt(() => api.rejectJoin(join.device))) onDone();
          }}
        />
      </div>
      <ErrorText message={error} />
    </li>
  );
}
