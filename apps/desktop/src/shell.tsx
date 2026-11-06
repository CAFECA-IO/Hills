/** 應用外框、團隊看板、設定（ui-spec「應用外框」「團隊」「設定」M0 範圍）。 */
import { useState } from 'react';
import {
  api,
  PRESENCE_STATES,
  type AppInfo,
  type Code,
  type MemberView,
  type PresenceState,
  type SyncStatus,
} from './api';
import { Chat } from './chat';
import { useIdleAway, useLoad, useSyncStatus } from './hooks';
import { formatTime, getLocale, LOCALES, setLocale, t, type MessageKey } from './i18n';
import { BackupForm, PhraseFlow } from './onboarding';
import { Button, Card, CodeBox, ConfirmButton, ErrorText, Field, useAction } from './ui';

type Page = 'team' | 'chat' | 'settings';

const SYNC_ICON: Record<SyncStatus, string> = {
  Synced: '●',
  Syncing: '◐',
  Offline: '○',
  Pending: '○',
};

export function SyncIndicator() {
  const status = useSyncStatus();
  if (!status) return null;
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-sm text-muted hover:text-fg"
      onClick={() => void api.syncNow().catch(() => undefined)}
      aria-live="polite"
    >
      <span aria-hidden className={status === 'Synced' ? 'text-primary' : ''}>
        {SYNC_ICON[status]}
      </span>
      {t(`sync.${status}` as MessageKey)}
    </button>
  );
}

const PRESENCE_ICON: Record<PresenceState, string> = {
  Online: '●',
  Busy: '◉',
  Meeting: '◑',
  Focus: '◎',
  Away: '◌',
  Leave: '○',
  Offline: '○',
};

function PresenceBadge({ state }: { state: PresenceState | null }) {
  const s = state ?? 'Offline';
  const color =
    s === 'Online'
      ? 'text-primary'
      : s === 'Offline' || s === 'Leave'
        ? 'text-muted'
        : 'text-warning';
  return (
    <span className="flex items-center gap-1 text-sm">
      <span aria-hidden className={color}>
        {PRESENCE_ICON[s]}
      </span>
      {t(`presence.${s}` as MessageKey)}
    </span>
  );
}

export function Shell({ info }: { info: AppInfo }) {
  const [page, setPage] = useState<Page>('team');
  const overview = useLoad(api.overview, ['org', 'roster', 'presence']);
  const me = overview.data?.members.find((m) => m.isMe);
  useIdleAway(() => (me ? { state: me.presence ?? 'Online', note: me.note } : null));
  const convs = useLoad(api.conversations, ['convs', 'message', 'doc']);
  const unread = (convs.data ?? []).reduce((n, c) => n + c.unread, 0);
  const nav: [Page, MessageKey, string][] = [
    ['team', 'nav.team', '◉'],
    ['chat', 'nav.chat', '✉'],
    ['settings', 'nav.settings', '⚙'],
  ];
  return (
    <div className="flex min-h-screen">
      <nav className="flex w-52 flex-col gap-1 border-r border-line bg-surface p-4">
        <div className="mb-4">
          <p className="text-lg font-semibold text-primary">{t('app.name')}</p>
          <p className="truncate text-sm text-muted">{overview.data?.orgName ?? info.orgName}</p>
        </div>
        {nav.map(([p, label, icon]) => (
          <button
            key={p}
            type="button"
            aria-current={page === p ? 'page' : undefined}
            onClick={() => setPage(p)}
            className={`flex items-center gap-2 rounded px-3 py-2 text-left text-sm ${page === p ? 'bg-bg font-medium text-primary' : 'hover:bg-bg'}`}
          >
            <span aria-hidden>{icon}</span>
            {t(label)}
            {p === 'chat' && unread > 0 && (
              <span
                className="ml-auto rounded-full bg-primary px-2 text-xs text-on-primary"
                aria-label={t('chat.unread', { count: unread })}
              >
                {unread}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-6 py-3">
          <h1 className="text-lg font-semibold">
            {t(page === 'team' ? 'team.title' : page === 'chat' ? 'chat.title' : 'settings.title')}
          </h1>
          <SyncIndicator />
        </header>
        <main className="flex-1 overflow-auto p-6">
          {page === 'team' ? (
            <TeamBoard
              members={overview.data?.members ?? []}
              teams={overview.data?.teams ?? []}
              error={overview.error}
            />
          ) : page === 'chat' ? (
            <Chat members={overview.data?.members ?? []} />
          ) : (
            <Settings
              info={info}
              members={overview.data?.members ?? []}
              orgName={overview.data?.orgName ?? ''}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function MyStatus({ me }: { me: MemberView }) {
  const [state, setState] = useState<PresenceState>(me.presence ?? 'Online');
  const [note, setNote] = useState(me.note);
  const { busy, error, attempt } = useAction();
  return (
    <Card className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="my-state" className="text-sm font-medium">
          {t('team.myStatus')}
        </label>
        <select
          id="my-state"
          className="rounded border border-line bg-surface px-3 py-2 text-sm"
          value={state}
          onChange={(e) => setState(e.target.value as PresenceState)}
        >
          {PRESENCE_STATES.map((s) => (
            <option key={s} value={s}>
              {t(`presence.${s}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-60 flex-1">
        <Field
          label={t('team.note')}
          placeholder={t('team.note.placeholder')}
          value={note}
          onChange={setNote}
        />
      </div>
      <Button disabled={busy} onClick={() => void attempt(() => api.setPresence(state, note))}>
        {t('team.update')}
      </Button>
      {error && <ErrorText message={error} />}
    </Card>
  );
}

function TeamBoard({
  members,
  teams,
  error,
}: {
  members: MemberView[];
  teams: { id: string; name: string; members: string[] }[];
  error: string | null;
}) {
  const me = members.find((m) => m.isMe);
  const online = members.filter((m) => m.presence && m.presence !== 'Offline').length;
  const byId = new Map(members.map((m) => [m.id, m]));
  const grouped = teams.map((tm) => ({
    ...tm,
    list: tm.members.map((id) => byId.get(id)).filter((m): m is MemberView => Boolean(m)),
  }));
  const inTeam = new Set(teams.flatMap((tm) => tm.members));
  const loose = members.filter((m) => !inTeam.has(m.id));
  if (loose.length) grouped.push({ id: '', name: t('team.noTeam'), members: [], list: loose });
  return (
    <div className="flex flex-col gap-4">
      <ErrorText message={error} />
      {me && <MyStatus key={`${me.presence}-${me.note}`} me={me} />}
      <p className="text-sm text-muted">{t('team.summary', { online, total: members.length })}</p>
      {members.length <= 1 && <p className="text-sm text-muted">{t('team.empty')}</p>}
      {grouped.map((g) => (
        <Card key={g.id || 'none'}>
          <h2 className="mb-3 font-medium">{g.name}</h2>
          <ul className="flex flex-col divide-y divide-line">
            {g.list.map((m) => (
              <li key={m.id} className="grid grid-cols-[10rem_8rem_1fr] items-center gap-3 py-2">
                <span className="truncate">
                  {m.name}
                  {m.isMe && <span className="text-muted">{t('team.me')}</span>}
                  {m.isAdmin && (
                    <span className="ml-2 rounded border border-line px-1 text-xs text-muted">
                      {t('team.admin')}
                    </span>
                  )}
                </span>
                <PresenceBadge state={m.presence} />
                <span className="truncate text-sm text-muted">{m.note}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

type Tab = 'personal' | 'org' | 'members';

function Settings({
  info,
  members,
  orgName,
}: {
  info: AppInfo;
  members: MemberView[];
  orgName: string;
}) {
  const [tab, setTab] = useState<Tab>('personal');
  const tabs: [Tab, MessageKey][] = [
    ['personal', 'settings.tab.personal'],
    ['org', 'settings.tab.org'],
    ['members', 'settings.tab.members'],
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div role="tablist" className="flex gap-1 border-b border-line">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm ${tab === k ? 'border-b-2 border-primary font-medium text-primary' : 'text-muted hover:text-fg'}`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {tab === 'personal' && <PersonalTab />}
      {tab === 'org' && <OrgTab info={info} orgName={orgName} />}
      {tab === 'members' && <MembersTab info={info} members={members} />}
    </div>
  );
}

function PersonalTab() {
  const devices = useLoad(api.devices, ['roster']);
  const [linking, setLinking] = useState(false);
  const [reverify, setReverify] = useState(false);
  const { error, attempt } = useAction();
  if (reverify) {
    return <PhraseFlow onDone={() => setReverify(false)} onCancel={() => setReverify(false)} />;
  }
  return (
    <>
      <Card className="flex items-center justify-between gap-3">
        <label htmlFor="lang" className="text-sm font-medium">
          {t('settings.language')}
        </label>
        <select
          id="lang"
          className="rounded border border-line bg-surface px-3 py-2 text-sm"
          value={getLocale()}
          onChange={(e) => setLocale(e.target.value as (typeof LOCALES)[number])}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`lang.${l}` as MessageKey)}
            </option>
          ))}
        </select>
      </Card>
      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">{t('settings.devices')}</h2>
          {!linking && (
            <Button variant="secondary" onClick={() => setLinking(true)}>
              {t('settings.linkDevice')}
            </Button>
          )}
        </div>
        {linking && (
          <LinkOldDevice
            onClose={() => {
              setLinking(false);
              devices.reload();
            }}
          />
        )}
        <ul className="flex flex-col divide-y divide-line">
          {(devices.data ?? []).map((d) => (
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
        <ErrorText message={error ?? devices.error} />
      </Card>
      <div>
        <Button variant="secondary" onClick={() => setReverify(true)}>
          {t('settings.reverify')}
        </Button>
      </div>
    </>
  );
}

/** 舊裝置端：貼上新裝置綁定碼 → 比對 SAS → 確認。 */
function LinkOldDevice({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sas, setSas] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, run, attempt } = useAction();
  const cancel = () => {
    void api.linkCancel();
    onClose();
  };
  if (done) {
    return (
      <div className="flex items-center justify-between rounded border border-primary p-3 text-sm">
        <span role="status">{t('link.old.done')}</span>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded border border-line p-3">
      {!sas ? (
        <>
          <p className="text-sm text-muted">{t('link.old.desc')}</p>
          <Field label={t('link.old.code')} value={code} onChange={setCode} multiline autoFocus />
          <Field label={t('field.deviceName')} value={name} onChange={setName} />
          <div className="flex gap-2">
            <Button
              disabled={busy || !code.trim() || !name.trim()}
              onClick={async () => {
                const s = await run(() => api.linkDevice(code));
                if (s) setSas(s);
              }}
            >
              {busy ? t('common.loading') : t('link.old.connect')}
            </Button>
            <Button variant="secondary" onClick={cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">{t('link.old.sas')}</p>
          <p className="text-center font-mono text-4xl tracking-[0.3em]">{sas}</p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={async () => {
                if (await attempt(() => api.linkConfirm(name))) setDone(true);
              }}
            >
              {t('link.old.match')}
            </Button>
            <Button variant="danger" onClick={cancel}>
              {t('link.old.mismatch')}
            </Button>
          </div>
        </>
      )}
      <ErrorText message={error} />
    </div>
  );
}

function OrgTab({ info, orgName }: { info: AppInfo; orgName: string }) {
  const [name, setName] = useState(orgName);
  const [code, setCode] = useState<Code | null>(null);
  const { busy, error, run, attempt } = useAction();
  return (
    <>
      <Card className="flex flex-col gap-3">
        <Field label={t('settings.orgName')} value={name} onChange={setName} />
        {info.isAdmin && (
          <div>
            <Button
              disabled={busy || !name.trim() || name === orgName}
              onClick={() => void attempt(() => api.renameOrg(name))}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">{t('settings.orgCode')}</h2>
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
      </Card>
      {info.hasOrgRoot && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">{t('settings.backup')}</h2>
          <BackupForm />
        </Card>
      )}
      <ErrorText message={error} />
    </>
  );
}

const INVITE_HOURS = 72;

function MembersTab({ info, members }: { info: AppInfo; members: MemberView[] }) {
  const invites = useLoad(api.invites, ['org']);
  const [code, setCode] = useState<Code | null>(null);
  const [asAdmin, setAsAdmin] = useState(false);
  const { busy, error, run, attempt } = useAction();
  if (!info.isAdmin) {
    return <p className="text-sm text-muted">{t('members.adminOnly')}</p>;
  }
  return (
    <>
      <Card className="flex flex-col gap-3">
        <h2 className="font-medium">{t('members.invite')}</h2>
        <p className="text-sm text-muted">{t('members.invite.desc', { hours: INVITE_HOURS })}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
          {t('members.invite.admin')}
        </label>
        <div>
          <Button
            disabled={busy}
            onClick={async () => {
              const c = await run(() => api.createInvite(asAdmin));
              if (c) {
                setCode(c);
                invites.reload();
              }
            }}
          >
            {t('members.invite')}
          </Button>
        </div>
        {code && <CodeBox code={code.code} qrSvg={code.qrSvg} />}
      </Card>
      <Card className="flex flex-col gap-2">
        <h2 className="font-medium">{t('members.invites')}</h2>
        {(invites.data ?? []).length === 0 && (
          <p className="text-sm text-muted">{t('members.invites.empty')}</p>
        )}
        <ul className="flex flex-col divide-y divide-line text-sm">
          {(invites.data ?? []).map((i) => (
            <li key={i.id} className="flex justify-between gap-3 py-2">
              <span className="font-mono">{i.id}</span>
              <span>{t(i.admin ? 'members.invite.role.admin' : 'members.invite.role.member')}</span>
              <span className="text-muted">
                {i.mine
                  ? t('members.invite.expires', { time: formatTime(i.expiresAt) })
                  : t('members.invite.notMine')}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex flex-col gap-2">
        <h2 className="font-medium">{t('members.title')}</h2>
        <ul className="flex flex-col divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {m.name}
                {m.isMe && <span className="text-muted">{t('team.me')}</span>}
                {m.isAdmin && (
                  <span className="ml-2 rounded border border-line px-1 text-xs text-muted">
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
      <ErrorText message={error ?? invites.error} />
    </>
  );
}
