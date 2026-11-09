/** 設定 › 我是誰（ui-spec「設定」v0.37，D56、D57）：角色舞台與配色、名稱與時區、狀態、CAFECA 帳戶。 */
import { useState } from 'react';
import { api, type Look, type MemberProfile, type MemberView, type Overview } from '../api';
import { CHARACTER_KINDS, CharacterArt, kindOf } from '../characters';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { deviceTimezone, emptyProfile, isValidTimezone, timezoneOptions } from '../profile-utils';
import { StatusFields } from '../status';
import { LOOK_PALETTE, lookOf } from '../summit';
import {
  Button,
  CharacterStage,
  ErrorText,
  Field,
  GlassPanel,
  Select,
  SwatchGroup,
  useAction,
} from '../ui';
import { PART_LABELS } from './model';

const scope = (s: 'device' | 'me' | 'org') => ({
  scope: s,
  label: t(`settings.scope.${s}`),
});

export function MeGroup({ me, overview }: { me: MemberView; overview: Overview }) {
  const [look, setLook] = useState<Look>(lookOf(me));
  const [saved, setSaved] = useState(false);
  const { busy, error, attempt } = useAction();
  const kind = kindOf(look);
  const parts = PART_LABELS[kind];
  const keys = ['hair', 'shirt', 'skin'] as const;
  const tokens = [`look-${kind}-a`, 'shirt', `look-${kind}-c`];
  const dirty =
    !me.look ||
    look.kind !== (me.look.kind ?? 0) ||
    look.hair !== me.look.hair ||
    look.shirt !== me.look.shirt ||
    look.skin !== me.look.skin;
  return (
    <div className="flex min-h-0 flex-1 gap-5">
      <div className="flex w-80 shrink-0 flex-col items-center justify-end pb-2">
        <CharacterStage
          count={CHARACTER_KINDS.length}
          index={look.kind}
          onChange={(i) => {
            setLook({ ...look, kind: i });
            setSaved(false);
          }}
          label={t('character.current', { kind: t(`character.kind.${kind}`) })}
          prevLabel={t('character.prev')}
          nextLabel={t('character.next')}
        >
          <svg width={180} height={330} viewBox="0 0 100 240" aria-hidden="true">
            <CharacterArt look={look} animate />
          </svg>
        </CharacterStage>
      </div>
      <div className="scroll-panel flex min-h-0 flex-1 flex-col gap-4 pr-1">
        <GlassPanel id="settings-look" title={t('look.title')} scope={scope('me')}>
          <div className="flex flex-col gap-3">
            {keys.map((k, i) => (
              <SwatchGroup
                key={k}
                label={t(parts[i])}
                colors={Array.from(
                  { length: LOOK_PALETTE },
                  (_, n) => `var(--hills-${tokens[i]}-${n})`,
                )}
                value={look[k]}
                onChange={(n) => {
                  setLook({ ...look, [k]: n });
                  setSaved(false);
                }}
                optionLabel={(n) => t('look.swatch', { part: t(parts[i]), n: n + 1 })}
              />
            ))}
            <div className="flex items-center gap-3">
              <Button
                disabled={busy || !dirty}
                onClick={async () => {
                  if (await attempt(() => api.setProfile(look))) setSaved(true);
                }}
              >
                {t('common.save')}
              </Button>
              {saved && (
                <span role="status" className="text-sm text-st-online-text">
                  {t('look.saved')}
                </span>
              )}
            </div>
            <ErrorText message={error} />
          </div>
        </GlassPanel>
        <ProfilePanel me={me} />
        <GlassPanel id="settings-status" title={t('settings.status.title')} scope={scope('me')}>
          <StatusFields
            key={`${me.presence}-${me.until}-${me.location}-${me.note}`}
            me={me}
            overview={overview}
          />
        </GlassPanel>
        <CafecaPanel />
      </div>
    </div>
  );
}

function ProfilePanel({ me }: { me: MemberView }) {
  const p = useLoad(api.myProfile, ['doc']);
  if (!p.data) return <ErrorText message={p.error} />;
  return <ProfileForm key={p.data.updatedAt} me={me} initial={p.data} />;
}

function ProfileForm({ me, initial }: { me: MemberView; initial: MemberProfile }) {
  const [name, setName] = useState(initial.displayName);
  const [tz, setTz] = useState(initial.timezone);
  const [saved, setSaved] = useState(false);
  const { busy, error, attempt } = useAction();
  const nameError = name.trim().length > 40 ? t('profile.nameTooLong') : null;
  const tzError = isValidTimezone(tz) ? null : t('profile.invalidTz');
  return (
    <GlassPanel id="settings-profile" title={t('profile.title')} scope={scope('org')}>
      <div className="flex flex-col gap-3">
        <Field
          label={t('profile.displayName')}
          value={name}
          onChange={(v) => {
            setName(v);
            setSaved(false);
          }}
          placeholder={me.rosterName}
          hint={t('profile.displayName.hint', { name: me.rosterName })}
          error={nameError}
        />
        <Field label={t('profile.timezone')} error={tzError}>
          <Select
            value={tz}
            onChange={(e) => {
              setTz(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">{t('profile.timezone.device', { tz: deviceTimezone() })}</option>
            {timezoneOptions(tz).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={busy || !!nameError || !!tzError}
            onClick={async () => {
              const next = {
                ...emptyProfile(),
                ...initial,
                displayName: name.trim(),
                timezone: tz,
              };
              if (await attempt(() => api.setMyProfile(next))) setSaved(true);
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
        <ErrorText message={error} />
      </div>
    </GlassPanel>
  );
}

function CafecaPanel() {
  const account = useLoad(api.cafecaAccount, ['org']);
  if (!account.data) return <ErrorText message={account.error} />;
  return (
    <GlassPanel id="settings-cafeca" title={t('settings.cafeca')} scope={scope('me')}>
      <div className="flex flex-col gap-2">
        {account.data.handle && <p className="text-sm font-semibold">@{account.data.handle}</p>}
        <code className="break-all text-xs text-muted select-all">{account.data.address}</code>
        <p className="text-xs text-muted">{t('settings.cafeca.desc')}</p>
      </div>
    </GlassPanel>
  );
}
