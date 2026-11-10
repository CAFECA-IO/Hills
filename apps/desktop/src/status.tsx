/**
 * 左下角狀態選單（ui-spec「設定」狀態選單 v0.40：情境按鈕、精簡、回來時間跟著狀態、
 * 效果說明、倒數與自動回上線）與共用的狀態欄位；「設定 → 我是誰」也使用 `StatusFields`。
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  api,
  PRESENCE_STATES,
  type MemberView,
  type OfficeView,
  type Overview,
  type PresenceState,
} from './api';
import { Avatar, StatusBadge, stateLabel, statusTextClass } from './figures';
import { formatClock, formatDate, t, type MessageKey } from './i18n';
import {
  countdown,
  effectKey,
  optionTime,
  readSince,
  shouldAutoReturn,
  situations,
  todayAt,
  untilOptions,
  writeSince,
  type Situation,
} from './status-utils';
import {
  Button,
  Chip,
  ErrorText,
  Field,
  LinkButton,
  Popover,
  Pressable,
  Select,
  TextInput,
  Toast,
  useAction,
} from './ui';

const v = (name: string) => `var(--hills-${name})`;

/** 狀態色 token（倒數環）。 */
const RING_TOKEN: Record<Exclude<PresenceState, 'Offline'>, string> = {
  Online: 'st-online',
  Busy: 'st-busy',
  Meeting: 'st-busy',
  Lunch: 'st-lunch',
  Away: 'st-away',
  Focus: 'st-focus',
  Leave: 'st-leave',
};

export function locationLabel(code: string, offices: OfficeView[]): string {
  if (code === 'remote') return t('location.remote');
  const o = offices.find((x) => `office:${x.id}` === code);
  return o ? o.name : t('location.hidden');
}

interface Snapshot {
  state: PresenceState;
  until: number | null;
  note: string;
  location: string;
}

const snapshot = (me: MemberView): Snapshot => ({
  state: me.presence ?? 'Online',
  until: me.until,
  note: me.note,
  location: me.location,
});

async function apply(s: Snapshot) {
  writeSince(s.until);
  await api.setPresenceFull(s.state, s.note, s.until, s.location);
}

/** 狀態的回來時間文字：休假顯示日期，其他顯示 24 小時制時刻。 */
const untilText = (state: PresenceState | null, until: number) =>
  state === 'Leave' ? formatDate(until) : formatClock(until);

interface ToastInfo {
  message: string;
  undo: Snapshot;
  key: number;
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
  const [toast, setToast] = useState<ToastInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  // E：到期自動回上線（technical-design §5.1 v0.32；只由本人的 app 執行）
  const returned = useRef<number | null>(null);
  useEffect(() => {
    if (!shouldAutoReturn(me.presence, me.until, now) || returned.current === me.until) return;
    returned.current = me.until;
    const before = snapshot(me);
    void apply({ ...before, state: 'Online', until: null }).then(() =>
      setToast({
        message: t('status.autoBack', { state: stateLabel(before.state) }),
        undo: { ...before, until: null },
        key: Date.now(),
      }),
    );
  }, [me, now]);
  const left = countdown(me.until, now, readSince(me.until));
  const ring = me.presence && me.presence !== 'Leave' && left ? left : null;
  const c = 2 * Math.PI * 27;
  return (
    <div className="relative mt-auto flex flex-col items-center">
      <Pressable
        ref={btn}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('status.menu.label', { state: stateLabel(me.presence) })}
        className="flex w-16 flex-col items-center gap-1 rounded-control py-1.5 hover:bg-bg"
      >
        <span className="relative flex size-13 items-center justify-center">
          {ring && me.presence && me.presence !== 'Offline' && (
            <svg viewBox="0 0 60 60" aria-hidden="true" className="absolute inset-0 size-full">
              <circle cx={30} cy={30} r={27} fill="none" stroke={v('border')} strokeWidth={3} />
              <circle
                cx={30}
                cy={30}
                r={27}
                fill="none"
                stroke={v(RING_TOKEN[me.presence])}
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray={`${ring.ratio * c} ${c}`}
                transform="rotate(-90 30 30)"
              />
            </svg>
          )}
          <Avatar member={me} size={44} />
        </span>
        <span
          className={`max-w-full truncate text-2xs font-semibold ${statusTextClass[me.presence ?? 'Offline']}`}
        >
          {stateLabel(me.presence)}
          {ring && ` · ${t('status.minutesLeft', { m: ring.minutes })}`}
        </span>
      </Pressable>
      {open && (
        <StatusPanel
          key={`${me.presence}-${me.until}-${me.location}-${me.note}`}
          me={me}
          overview={overview}
          anchorRef={btn}
          onClose={() => setOpen(false)}
          onApplied={(message, undo) => {
            setNow(Date.now());
            setToast({ message, undo, key: Date.now() });
          }}
          onOpenLook={() => {
            setOpen(false);
            onOpenLook();
          }}
        />
      )}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          action={{
            label: t('guide.undo'),
            onClick: () => {
              void apply(toast.undo);
              setToast(null);
            },
          }}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

const RELATIVE = new Set<Situation['key']>(['focus25', 'away5', 'away15']);

/** 相對時間的情境（專注 25 分、暫離 5 / 15 分）以按下的當下重新起算；整點、午休結束不變。 */
function restart(sit: Situation, openedAt: number): Situation {
  return RELATIVE.has(sit.key) && sit.until !== null
    ? { ...sit, until: Date.now() + (sit.until - openedAt) }
    : sit;
}

const SITUATION_LABEL: Record<Situation['key'], MessageKey> = {
  back: 'status.sit.back',
  focus25: 'status.sit.focus25',
  meeting: 'status.sit.meeting',
  lunch: 'status.sit.lunch',
  away5: 'status.sit.away5',
  away15: 'status.sit.away15',
};

function StatusPanel({
  me,
  overview,
  onClose,
  onApplied,
  anchorRef,
  onOpenLook,
}: {
  me: MemberView;
  overview: Overview;
  onClose: () => void;
  onApplied: (message: string, undo: Snapshot) => void;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenLook: () => void;
}) {
  const [more, setMore] = useState(false);
  const { busy, error, attempt } = useAction();
  const [now] = useState(() => Date.now());
  const sits = situations(now, me.presence, overview.lunchBreak);
  const moreId = useId();
  const pick = async (sit: Situation) => {
    const s = restart(sit, now);
    const before = snapshot(me);
    if (await attempt(() => apply({ ...before, state: s.state, until: s.until }))) {
      const label = t(SITUATION_LABEL[s.key], { time: s.until ? formatClock(s.until) : '' });
      onApplied(
        s.until
          ? t('status.applied', { label, time: formatClock(s.until) })
          : t('status.appliedBack'),
        before,
      );
      onClose();
    }
  };
  return (
    <Popover
      label={t('status.menu')}
      onClose={onClose}
      anchorRef={anchorRef}
      className="absolute bottom-0 left-full z-20 ml-3 flex max-h-[calc(100vh-2rem)] w-88 flex-col gap-3 overflow-y-auto p-4"
    >
      <CurrentStatus me={me} />
      <div className="h-px bg-line" />
      <div className="grid grid-cols-2 gap-2">
        {sits.map((s) => (
          <Chip
            key={s.key}
            disabled={busy}
            onClick={() => void pick(s)}
            className="justify-start gap-2.5 rounded-control px-3 py-2 text-left"
          >
            <StatusBadge state={s.state} withText={false} size={20} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-bold text-fg">
                {t(SITUATION_LABEL[s.key], { time: s.until ? formatClock(s.until) : '' })}
              </span>
              <span className="truncate text-2xs text-muted">
                {s.until
                  ? t('home.until', { time: formatClock(s.until) })
                  : t('status.sit.backHint')}
              </span>
            </span>
          </Chip>
        ))}
      </div>
      <ErrorText message={error} />
      <LinkButton aria-expanded={more} aria-controls={moreId} onClick={() => setMore((x) => !x)}>
        {more ? t('status.less') : t('status.more')}
      </LinkButton>
      {more && (
        <div id={moreId}>
          <StatusFields me={me} overview={overview} onDone={onClose} onCancel={onClose} />
        </div>
      )}
      <LinkButton tone="muted" onClick={onOpenLook}>
        {t('status.myLook')}
      </LinkButton>
    </Popover>
  );
}

/** D：目前狀態列＝頭像 + 狀態 · 回來時間 + 一句效果說明。 */
function CurrentStatus({ me }: { me: MemberView }) {
  const st = me.presence;
  const until = me.until;
  return (
    <div className="flex items-center gap-3">
      <Avatar member={me} size={40} />
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-bold ${statusTextClass[st ?? 'Offline']}`}>
          {stateLabel(st)}
          {until && ` · ${t('home.until', { time: untilText(st, until) })}`}
        </p>
        <p className="text-xs text-muted">
          {t(effectKey(st, until), { time: until ? untilText(st, until) : '' })}
        </p>
      </div>
    </div>
  );
}

/** 狀態、回來時間、地點、狀態文字（狀態選單「更多」與「設定 → 我是誰」共用）。 */
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
  const [now] = useState(() => Date.now());
  const options = untilOptions(state, now, lunch);
  const save = async () => {
    if (await attempt(() => apply({ state, until, note, location }))) onDone?.();
  };
  const optionLabel = (o: (typeof options)[number]) =>
    o.kind === 'minutes'
      ? t('time.minutes', { m: o.m })
      : o.kind === 'lunchEnd'
        ? t('status.until.lunchEnd', { time: formatClock(o.ms) })
        : o.label === ':30'
          ? t('status.until.half', { time: formatClock(o.ms) })
          : t('status.until.hour', { time: formatClock(o.ms) });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span id={ids.state} className="text-sm font-medium">
          {t('team.myStatus')}
        </span>
        <div role="group" aria-labelledby={ids.state} className="grid grid-cols-4 gap-1.5">
          {PRESENCE_STATES.map((s) => (
            <Chip
              key={s}
              selected={state === s}
              onClick={() => setState(s)}
              className="flex-col justify-center gap-1 rounded-control py-2"
            >
              <StatusBadge state={s} withText={false} size={18} />
              <span className="text-xs">{stateLabel(s)}</span>
            </Chip>
          ))}
        </div>
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
          {options.map((o) => (
            <Button
              key={optionLabel(o)}
              variant="secondary"
              size="sm"
              onClick={() => setUntil(optionTime(o, Date.now()))}
            >
              {optionLabel(o)}
            </Button>
          ))}
          <TextInput
            size="sm"
            type={state === 'Leave' ? 'date' : 'time'}
            aria-label={t('status.until.at')}
            value={
              until
                ? state === 'Leave'
                  ? new Date(until - new Date(until).getTimezoneOffset() * 60_000)
                      .toISOString()
                      .slice(0, 10)
                  : formatClock(until).slice(-5)
                : ''
            }
            onChange={(e) => {
              if (!e.target.value) return;
              if (state === 'Leave') {
                setUntil(todayAt('23:59', new Date(`${e.target.value}T12:00`).getTime()));
                return;
              }
              let ms = todayAt(e.target.value, Date.now());
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
