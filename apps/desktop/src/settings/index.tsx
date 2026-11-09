/**
 * 設定頁（ui-spec「設定」v0.37，D56「晨光山丘毛玻璃」）：七個分組、範圍標籤、營地進度、搜尋設定。
 * 背景是晨光山丘插畫（深色模式為夜晚），內容在毛玻璃上。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type AppInfo, type JoinRequestView, type Overview } from '../api';
import { useLoad } from '../hooks';
import { t } from '../i18n';
import { GlassNav, GlassPanel, GlassScope, ListButton, Popover, Pressable, TextInput } from '../ui';
import { AboutGroup } from './about';
import { AiGroup } from './ai';
import { MeGroup } from './me';
import { campProgress, GROUPS, readFlag, searchSettings, type Group } from './model';
import { PeopleGroup } from './people';
import { RhythmGroup } from './rhythm';
import { RulesGroup } from './rules';
import { SecurityGroup } from './security';

export { readGroup, writeGroup, type Group } from './model';

const v = (name: string) => `var(--hills-${name})`;

/** 晨光山丘背景（深色模式由 token 切換成夜晚）。 */
function DawnBackdrop() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 size-full"
      viewBox="0 0 1280 800"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="hills-dawn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={v('dawn-top')} />
          <stop offset="0.22" stopColor={v('dawn-upper')} />
          <stop offset="0.55" stopColor={v('dawn-lower')} />
          <stop offset="1" stopColor={v('dawn-bottom')} />
        </linearGradient>
      </defs>
      <rect width="1280" height="800" fill="url(#hills-dawn)" />
      <circle cx="1000" cy="160" r="110" fill={v('dawn-sun')} opacity={0.35} />
      <circle cx="1000" cy="160" r="70" fill={v('dawn-sun')} />
      <path
        d="M0 520 C200 430 360 470 540 410 C720 350 900 400 1280 330 L1280 800 L0 800 Z"
        fill={v('dawn-hill-far')}
      />
      <path
        d="M0 610 C240 540 460 590 700 540 C940 490 1100 540 1280 500 L1280 800 L0 800 Z"
        fill={v('dawn-hill-mid')}
      />
      <path d="M0 700 C300 650 640 700 1280 640 L1280 800 L0 800 Z" fill={v('dawn-hill-near')} />
    </svg>
  );
}

const noJoins = () => Promise.resolve<JoinRequestView[]>([]);

export function Settings({
  info,
  overview,
  group,
  onGroup,
}: {
  info: AppInfo;
  overview: Overview;
  group: Group;
  onGroup: (g: Group) => void;
}) {
  const me = overview.members.find((m) => m.isMe);
  const joins = useLoad(info.isAdmin ? api.pendingJoins : noJoins, ['joins', 'roster']);
  const pending = joins.data?.length ?? 0;
  const [target, setTarget] = useState<string | null>(null);
  const progress = useProgress(info, me?.look != null);
  const backupPending = info.hasOrgRoot && !readFlag('backup');
  useEffect(() => {
    if (!target) return;
    const id = window.setTimeout(() => {
      document.getElementById(`settings-${target}`)?.scrollIntoView({ block: 'center' });
      setTarget(null);
    }, 60);
    return () => window.clearTimeout(id);
  }, [target, group]);
  const jump = (g: Group, item?: string) => {
    onGroup(g);
    if (item) setTarget(item);
  };
  let body: ReactNode;
  if (group === 'me' && me) body = <MeGroup me={me} overview={overview} />;
  else {
    const inner =
      group === 'rhythm' ? (
        <RhythmGroup />
      ) : group === 'security' ? (
        <SecurityGroup info={info} />
      ) : group === 'people' ? (
        <PeopleGroup info={info} members={overview.members} overview={overview} />
      ) : group === 'rules' ? (
        <RulesGroup info={info} overview={overview} />
      ) : group === 'ai' ? (
        <AiGroup info={info} />
      ) : (
        <AboutGroup />
      );
    body = (
      <div className="scroll-panel mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 pr-1">
        {inner}
      </div>
    );
  }
  return (
    <div className="relative h-full overflow-hidden rounded-card">
      <DawnBackdrop />
      <div className="relative flex h-full flex-col gap-4 p-5">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-fg">
            {t('settings.greeting', { name: me?.name ?? '' })}
          </p>
          <SettingsSearch isAdmin={info.isAdmin} onJump={jump} />
          <CampProgress items={progress} onJump={jump} />
        </div>
        <GlassScope>{body}</GlassScope>
        <GlassNav
          label={t('settings.group.label')}
          value={group}
          onChange={(g) => onGroup(g)}
          items={GROUPS.map((g) => ({
            value: g,
            label: t(`settings.group.${g}`),
            count: g === 'people' ? pending : undefined,
            countLabel: g === 'people' ? t('joins.badge', { count: pending }) : undefined,
            dotLabel:
              g === 'security' && backupPending ? t('settings.security.pending') : undefined,
          }))}
        />
      </div>
    </div>
  );
}

function useProgress(info: AppInfo, hasLook: boolean) {
  const profile = useLoad(api.myProfile, ['doc']);
  const devices = useLoad(api.devices, ['roster', 'device-added']);
  const mcp = useLoad(info.isAdmin ? api.mcpSettings : () => Promise.resolve(null), ['org']);
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener('hills-progress', on);
    return () => window.removeEventListener('hills-progress', on);
  }, []);
  const allowed = (mcp.data as { allowed?: boolean } | null)?.allowed ?? false;
  return campProgress({
    hasLook,
    profileSaved: (profile.data?.updatedAt ?? 0) > 0,
    hoursSaved: readFlag('hours'),
    notifySeen: readFlag('notify'),
    deviceCount: devices.data?.length ?? 0,
    singleDevice: readFlag('singleDevice'),
    isAdmin: info.isAdmin,
    hasOrgRoot: info.hasOrgRoot,
    backupDone: readFlag('backup'),
    aiDecided: allowed || readFlag('ai'),
  });
}

function CampProgress({
  items,
  onJump,
}: {
  items: ReturnType<typeof campProgress>;
  onJump: (g: Group) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative">
      <Pressable
        ref={btn}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('progress.label', { done, total })}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center rounded-full"
      >
        <svg width={40} height={40} viewBox="0 0 40 40" aria-hidden="true">
          <circle
            cx={20}
            cy={20}
            r={r}
            fill={v('glass-strong')}
            stroke={v('border')}
            strokeWidth={5}
          />
          <circle
            cx={20}
            cy={20}
            r={r}
            fill="none"
            stroke={v('st-online')}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${(done / Math.max(total, 1)) * c} ${c}`}
            transform="rotate(-90 20 20)"
          />
          {done === total ? (
            <path
              d="M16 27V12l9 3.5-9 3.5"
              fill={v('st-online')}
              stroke={v('ink')}
              strokeWidth={1.2}
            />
          ) : (
            <text x={20} y={24} textAnchor="middle" fontSize={11} fontWeight={700} fill={v('text')}>
              {done}/{total}
            </text>
          )}
        </svg>
      </Pressable>
      {open && (
        <Popover
          label={t('progress.title')}
          anchorRef={btn}
          onClose={() => setOpen(false)}
          className="absolute top-full right-0 z-20 mt-2 flex w-72 flex-col gap-1 p-3"
        >
          <p className="px-2 pb-1 text-sm font-bold">
            {done === total ? t('progress.done') : t('progress.label', { done, total })}
          </p>
          {items.map((it) => (
            <ListButton
              key={it.key}
              onClick={() => {
                setOpen(false);
                onJump(it.group);
              }}
            >
              <span className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`size-2.5 rounded-full ${it.done ? 'bg-st-online' : 'bg-line'}`}
                />
                <span className={it.done ? 'text-muted line-through' : ''}>{t(it.label)}</span>
              </span>
            </ListButton>
          ))}
        </Popover>
      )}
    </div>
  );
}

function SettingsSearch({
  isAdmin,
  onJump,
}: {
  isAdmin: boolean;
  onJump: (g: Group, item: string) => void;
}) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const results = searchSettings(q, t, isAdmin);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (i: number) => {
    const it = results[i];
    if (!it) return;
    onJump(it.group, it.id);
    setQ('');
  };
  return (
    <div className="relative w-72">
      <TextInput
        ref={input}
        type="search"
        aria-label={t('search.settings')}
        placeholder={t('search.settings')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') pick(0);
          if (e.key === 'Escape') setQ('');
        }}
        className="w-full rounded-full"
      />
      {q.trim() && (
        <div className="absolute top-full right-0 left-0 z-20 mt-2">
          <GlassPanel padding="none" className="p-2">
            {results.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted">{t('search.settings.empty')}</p>
            ) : (
              <ul className="flex flex-col">
                {results.map((it, i) => (
                  <li key={it.id}>
                    <ListButton onClick={() => pick(i)}>
                      <span className="text-sm">
                        <span className="text-muted">{t(`settings.group.${it.group}`)} › </span>
                        {t(it.label)}
                      </span>
                    </ListButton>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
