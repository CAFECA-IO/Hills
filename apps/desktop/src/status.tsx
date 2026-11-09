/**
 * 左下角狀態選單（ui-spec「設定」M1 補充、D40）與共用的狀態欄位；
 * 「設定 → 我是誰」也使用 `StatusFields`（D56）。
 */
import { useId, useRef, useState, type RefObject } from 'react';
import {
  api,
  PRESENCE_STATES,
  type MemberView,
  type OfficeView,
  type Overview,
  type PresenceState,
} from './api';
import { Portrait, StatusBadge, stateLabel } from './figures';
import { formatClock, formatDate, t } from './i18n';
import { lookOf } from './summit';
import {
  Button,
  ErrorText,
  Field,
  LinkButton,
  Popover,
  Pressable,
  Select,
  TextInput,
  useAction,
} from './ui';

const UNTIL_PRESETS = [15, 30, 60] as const;

function inLunch(lunch: Overview['lunchBreak'], now: Date): boolean {
  if (!lunch) return false;
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return hm >= lunch.start && hm < lunch.end;
}

function todayAt(hm: string, now = new Date()): number {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function locationLabel(code: string, offices: OfficeView[]): string {
  if (code === 'remote') return t('location.remote');
  const o = offices.find((x) => `office:${x.id}` === code);
  return o ? o.name : t('location.hidden');
}

export function StatusMenu({
  me,
  overview,
  onOpenLook,
}: {
  me: MemberView;
  overview: Overview;
  /** 開啟「設定 → 我是誰」（D56） */
  onOpenLook: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative mt-auto flex flex-col items-center">
      <Pressable
        ref={btn}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex flex-col items-center gap-1 rounded-control px-2 py-1 hover:bg-bg"
      >
        <Portrait look={lookOf(me)} state={me.presence} size={52} label={t('status.menu')} />
        <StatusBadge state={me.presence} />
      </Pressable>
      {open && (
        <StatusPanel
          key={`${me.presence}-${me.until}-${me.location}-${me.note}`}
          me={me}
          overview={overview}
          anchorRef={btn}
          onClose={() => setOpen(false)}
          onOpenLook={() => {
            setOpen(false);
            onOpenLook();
          }}
        />
      )}
    </div>
  );
}

function StatusPanel({
  me,
  overview,
  onClose,
  anchorRef,
  onOpenLook,
}: {
  me: MemberView;
  overview: Overview;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenLook: () => void;
}) {
  return (
    <Popover
      label={t('status.menu')}
      onClose={onClose}
      anchorRef={anchorRef}
      className="absolute bottom-0 left-full ml-3 flex w-80 flex-col gap-3 p-4"
    >
      <StatusFields me={me} overview={overview} onDone={onClose} onCancel={onClose} />
      <LinkButton onClick={onOpenLook}>{t('status.myLook')}</LinkButton>
    </Popover>
  );
}

/** 狀態、回來時間、地點、狀態文字（狀態選單與「設定 → 我是誰」共用）。 */
export function StatusFields({
  me,
  overview,
  onDone,
  onCancel,
}: {
  me: MemberView;
  overview: Overview;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [state, setState] = useState<PresenceState>(me.presence ?? 'Online');
  const [until, setUntil] = useState<number | null>(me.until);
  const [location, setLocation] = useState(me.location);
  const [note, setNote] = useState(me.note);
  const { busy, error, attempt } = useAction();
  const ids = { state: useId(), loc: useId(), until: useId() };
  const lunch = overview.lunchBreak;
  const save = async (s = state, u = until) => {
    if (await attempt(() => api.setPresenceFull(s, note, u, location))) onDone?.();
  };
  return (
    <div className="flex flex-col gap-3">
      {lunch && inLunch(lunch, new Date()) && state !== 'Lunch' && (
        <Button
          variant="soft"
          disabled={busy}
          onClick={() => void save('Lunch', todayAt(lunch.end))}
        >
          {t('status.lunchNow', { end: lunch.end })}
        </Button>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.state} className="text-sm font-medium">
          {t('team.myStatus')}
        </label>
        <Select
          id={ids.state}
          className="w-full"
          value={state}
          onChange={(e) => setState(e.target.value as PresenceState)}
        >
          {PRESENCE_STATES.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span id={ids.until} className="text-sm font-medium">
          {t('status.until')}
        </span>
        <div role="group" aria-labelledby={ids.until} className="flex flex-wrap gap-1">
          <Button
            variant={until === null ? 'soft' : 'secondary'}
            size="sm"
            onClick={() => setUntil(null)}
          >
            {t('status.until.none')}
          </Button>
          {UNTIL_PRESETS.map((m) => (
            <Button
              key={m}
              variant="secondary"
              size="sm"
              onClick={() => setUntil(Date.now() + m * 60_000)}
            >
              {t('time.minutes', { m })}
            </Button>
          ))}
          <TextInput
            size="sm"
            type="time"
            aria-label={t('status.until.at')}
            value={until ? formatClock(until).slice(-5) : ''}
            onChange={(e) => {
              if (!e.target.value) return;
              let ms = todayAt(e.target.value);
              if (ms < Date.now()) ms += 86_400_000;
              setUntil(ms);
            }}
          />
        </div>
        {until && (
          <p className="text-xs text-muted">
            {state === 'Leave'
              ? t('home.leaveUntil', { date: formatDate(until) })
              : t('home.until', { time: formatClock(until) })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.loc} className="text-sm font-medium">
          {t('status.location')}
        </label>
        <Select
          id={ids.loc}
          className="w-full"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        >
          {overview.offices.map((o) => (
            <option key={o.id} value={`office:${o.id}`}>
              {o.name}
            </option>
          ))}
          <option value="remote">{t('location.remote')}</option>
          <option value="hidden">{t('location.hidden')}</option>
        </Select>
      </div>
      <Field
        label={t('team.note')}
        placeholder={t('team.note.placeholder')}
        value={note}
        onChange={setNote}
      />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {t('team.update')}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
      <ErrorText message={error} />
    </div>
  );
}
