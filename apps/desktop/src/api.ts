/**
 * 與 Rust 端（hills-node）溝通的唯一入口。前端不接觸金鑰，只呼叫 command、接收事件。
 * 在瀏覽器（非 Tauri）開發時使用 dev/mockBackend 的假資料，正式建置不包含。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export type SyncStatus = 'Pending' | 'Offline' | 'Syncing' | 'Synced';
export type PresenceState = 'Online' | 'Busy' | 'Meeting' | 'Focus' | 'Away' | 'Leave' | 'Offline';
export const PRESENCE_STATES: readonly PresenceState[] = [
  'Online',
  'Busy',
  'Meeting',
  'Focus',
  'Away',
  'Leave',
];

export interface AppInfo {
  phase: 'welcome' | 'pending' | 'ready';
  memberId: string | null;
  orgName: string | null;
  isAdmin: boolean;
  sync: SyncStatus | null;
  hasOrgRoot: boolean;
}

export interface MemberView {
  id: string;
  name: string;
  isAdmin: boolean;
  isMe: boolean;
  joinedAt: number;
  presence: PresenceState | null;
  note: string;
}

export interface TeamView {
  id: string;
  name: string;
  members: string[];
}

export interface Overview {
  orgName: string;
  members: MemberView[];
  teams: TeamView[];
}

export interface Code {
  code: string;
  qrSvg: string;
}

export interface InviteView {
  id: string;
  admin: boolean;
  expiresAt: number;
  mine: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  issuedAt: number;
  thisDevice: boolean;
}

export interface CreateOrgArgs {
  orgName: string;
  myName: string;
  deviceName: string;
  mailboxCode: string;
  timezone: string;
  locale: string;
  teamName: string;
}

export const EVENTS = {
  node: 'hills://node',
  linkSas: 'hills://link-sas',
  linkDone: 'hills://link-done',
} as const;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (payload: T) => void) => Promise<UnlistenFn>;

interface Backend {
  invoke: Invoke;
  listen: Listen;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let backend: Promise<Backend>;
if (isTauri) {
  backend = Promise.resolve({
    invoke: tauriInvoke,
    listen: (event, cb) => tauriListen(event, (e) => cb(e.payload as never)),
  });
} else if (import.meta.env.DEV) {
  backend = import('./dev/mockBackend').then((m) => m.mockBackend);
} else {
  backend = Promise.reject(new Error('not running inside Tauri'));
}

const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (await backend).invoke<T>(cmd, args);

export const listen = async <T>(event: string, cb: (payload: T) => void) =>
  (await backend).listen<T>(event, cb);

/** 把後端錯誤轉為字串（Tauri command 以字串回傳錯誤）。 */
export const errorMessage = (e: unknown): string =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  createOrg: (args: CreateOrgArgs) => call<void>('create_org', { args }),
  joinOrg: (inviteCode: string, myName: string, deviceName: string) =>
    call<void>('join_org', { inviteCode, myName, deviceName }),
  recover: (words: string, orgCode: string, deviceName: string) =>
    call<void>('recover', { words, orgCode, deviceName }),
  recoveryWords: (locale: string) => call<string[]>('recovery_words', { locale }),
  exportOrgRootBackup: (password: string) => call<string>('export_org_root_backup', { password }),
  linkStart: (orgCode: string, deviceName: string) =>
    call<Code>('link_start', { orgCode, deviceName }),
  linkCancel: () => call<void>('link_cancel'),
  linkDevice: (code: string) => call<string>('link_device', { code }),
  linkConfirm: (deviceName: string) => call<void>('link_confirm', { deviceName }),
  overview: () => call<Overview>('overview'),
  setPresence: (presence: PresenceState, note: string) =>
    call<void>('set_presence', { presence, note }),
  syncStatus: () => call<SyncStatus | null>('sync_status'),
  syncNow: () => call<void>('sync_now'),
  orgCode: () => call<Code>('org_code'),
  createInvite: (admin: boolean) => call<Code>('create_invite', { admin }),
  invites: () => call<InviteView[]>('invites'),
  renameOrg: (name: string) => call<void>('rename_org', { name }),
  revokeMember: (memberId: string) => call<void>('revoke_member', { memberId }),
  devices: () => call<DeviceInfo[]>('devices'),
  revokeDevice: (deviceId: string) => call<void>('revoke_device', { deviceId }),
};
