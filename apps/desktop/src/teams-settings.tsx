/** 設定 → 成員與小組 →「小組」（ui-spec「設定 → 小組」v0.28，D49；technical-design §16.15）。 */
import { useState } from 'react';
import { api, type MemberView, type TeamInfo } from './api';
import { useLoad } from './hooks';
import { t } from './i18n';
import {
  removeMember,
  removedMembers,
  rosterChanged,
  splitTeams,
  toggleLead,
  addMember,
  type RosterDraft,
} from './teams-utils';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorText,
  Field,
  Select,
  TextInput,
  Tooltip,
  useAction,
} from './ui';

type Editing = { kind: 'new' } | { kind: 'edit'; team: TeamInfo };

/** 管理者看到全部小組；不是管理者的負責人只看到自己負責的小組。 */
export function TeamsCard({ members, isAdmin }: { members: MemberView[]; isAdmin: boolean }) {
  const data = useLoad(api.teamsInfo, ['org', 'roster', 'doc']);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { error, attempt } = useAction();
  const visible = (data.data ?? []).filter((x) => isAdmin || x.canManage);
  const { active, archived } = splitTeams(visible);
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const row = (tm: TeamInfo) => (
    <li key={tm.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="font-medium">{tm.name}</span>
      <span className="text-sm text-muted">
        {t('teams.count', { count: new Set([...tm.members, ...tm.leads]).size })} ·{' '}
        {tm.leads.length > 0
          ? t('teams.leads', { names: tm.leads.map(nameOf).join('、') })
          : t('teams.noLead')}
      </span>
      {tm.awaitingKey && (
        <Tooltip content={t('teams.awaitingKey.hint')}>
          <span tabIndex={0}>
            <Badge>{t('teams.awaitingKey')}</Badge>
          </span>
        </Tooltip>
      )}
      <span className="ml-auto flex gap-2">
        {tm.archived ? (
          isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (await attempt(() => api.archiveTeam(tm.id, false))) data.reload();
              }}
            >
              {t('teams.unarchive')}
            </Button>
          )
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing({ kind: 'edit', team: tm })}
          >
            {t('teams.manage')}
          </Button>
        )}
      </span>
    </li>
  );
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center">
        <h2 className="font-medium">{isAdmin ? t('teams.title') : t('teams.leadOnly')}</h2>
        {isAdmin && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={() => setEditing({ kind: 'new' })}
          >
            {t('teams.add')}
          </Button>
        )}
      </div>
      {active.length === 0 && <EmptyState>{t('teams.empty')}</EmptyState>}
      <ul className="flex flex-col divide-y divide-line">{active.map(row)}</ul>
      {archived.length > 0 && (
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? '▾' : '▸'} {t('teams.archived', { count: archived.length })}
          </Button>
          {showArchived && (
            <ul className="flex flex-col divide-y divide-line text-muted">{archived.map(row)}</ul>
          )}
        </div>
      )}
      <ErrorText message={error ?? data.error} />
      {editing && (
        <TeamDialog
          team={editing.kind === 'edit' ? editing.team : null}
          members={members}
          isAdmin={isAdmin}
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

function TeamDialog({
  team,
  members,
  isAdmin,
  onClose,
  onSaved,
}: {
  team: TeamInfo | null;
  members: MemberView[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial: RosterDraft = {
    name: team?.name ?? '',
    members: team?.members ?? [],
    leads: team?.leads ?? [],
  };
  const [d, setD] = useState<RosterDraft>(initial);
  const [pick, setPick] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, attempt } = useAction();
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  const removed = team ? removedMembers(team, d) : [];
  const candidates = members.filter((m) => !d.members.includes(m.id));

  const save = async (confirmed = false) => {
    const name = d.name.trim();
    if (!name) {
      setNameError(t('field.required'));
      return;
    }
    if (d.members.length === 0) return;
    if (removed.length > 0 && !confirmed) {
      setConfirming(true);
      return;
    }
    const ok = await attempt(async () => {
      if (!team) {
        await api.createTeam(name, d.members, d.leads);
        return;
      }
      if (isAdmin && name !== team.name) await api.renameTeam(team.id, name);
      if (rosterChanged(team, d)) await api.setTeamMembers(team.id, d.members, d.leads);
    });
    if (ok) onSaved();
  };

  return (
    <Dialog
      title={team ? t('teams.edit', { name: team.name }) : t('teams.new')}
      onClose={onClose}
      onSubmit={() => void save()}
      dirty={JSON.stringify(d) !== JSON.stringify(initial)}
    >
      {isAdmin && (
        <Field label={t('teams.name')} error={nameError} required>
          <TextInput
            autoFocus
            maxLength={40}
            value={d.name}
            onChange={(e) => {
              setD({ ...d, name: e.target.value });
              setNameError(null);
            }}
          />
        </Field>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('teams.members')}</span>
        {d.members.length === 0 && <ErrorText message={t('teams.needMember')} />}
        <ul className="flex max-h-64 flex-col divide-y divide-line overflow-y-auto">
          {d.members.map((id) => (
            <li key={id} className="flex items-center gap-3 py-1.5">
              <span className="flex-1 truncate">{nameOf(id)}</span>
              <label className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={d.leads.includes(id)} onChange={() => setD(toggleLead(d, id))} />
                {t('teams.lead')}
              </label>
              <Button variant="ghost" size="sm" onClick={() => setD(removeMember(d, id))}>
                {t('teams.remove')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {candidates.length > 0 && (
        <Field label={t('teams.addMember')}>
          <Select
            value={pick}
            onChange={(e) => {
              const id = e.target.value;
              if (id) setD(addMember(d, id));
              setPick('');
            }}
          >
            <option value="">{t('teams.addMember.pick')}</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="text-xs text-muted">{t('teams.keyHint')}</p>
      {confirming && (
        <ConfirmDialog
          title={t('teams.removed.title')}
          body={t('teams.removed.confirm', { names: removed.map(nameOf).join('、') })}
          tone="danger"
          confirmLabel={t('teams.removed.ok')}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            await save(true);
          }}
        />
      )}
      <ErrorText message={error} />
      <div className="flex items-center gap-2 pt-2">
        {team && isAdmin && (
          <ConfirmButton
            label={t('teams.archive')}
            message={t('teams.archive.confirm', { name: team.name })}
            onConfirm={async () => {
              if (await attempt(() => api.archiveTeam(team.id, true))) onSaved();
            }}
          />
        )}
        <span className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={d.members.length === 0 || confirming}>
            {team ? t('common.save') : t('teams.create')}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}
