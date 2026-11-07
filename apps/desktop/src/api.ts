/**
 * 與 Rust 端（hills-node）溝通的唯一入口。前端不接觸金鑰，只呼叫 command、接收事件。
 * 在瀏覽器（非 Tauri）開發時使用 dev/mockBackend 的假資料，正式建置不包含。
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

export type SyncStatus = 'Pending' | 'Offline' | 'Syncing' | 'Synced';
export type PresenceState =
  'Online' | 'Busy' | 'Meeting' | 'Focus' | 'Away' | 'Leave' | 'Offline' | 'Lunch';
/** 狀態選單的順序（ui-spec「視覺語言」狀態表）。 */
export const PRESENCE_STATES: readonly PresenceState[] = [
  'Online',
  'Busy',
  'Meeting',
  'Lunch',
  'Away',
  'Focus',
  'Leave',
];

/** `hidden` / `remote` / `office:<id>`（technical-design §5.1 v0.11）。 */
export type LocationCode = string;

export interface Look {
  hair: number;
  shirt: number;
  skin: number;
}

export interface AppInfo {
  /** legacy：舊版資料（復原詞時代），需清除後重新開始（technical-design §17.9） */
  phase: 'welcome' | 'pending' | 'ready' | 'legacy';
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
  /** 回來時間（ms） */
  until: number | null;
  location: LocationCode;
  look: Look | null;
}

export interface OfficeView {
  id: string;
  name: string;
}

export interface LunchBreak {
  start: string;
  end: string;
}

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';

export interface TaskStep {
  id: string;
  title: string;
  assignee: string | null;
  done: boolean;
  doneAt: number | null;
}

export interface Task {
  id: string;
  team: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
  dueAt: number | null;
  steps: TaskStep[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StepInput {
  id?: string | null;
  title: string;
  assignee: string | null;
  done: boolean;
}

export interface TaskInput {
  title: string;
  assignee: string | null;
  status?: TaskStatus | null;
  dueAt: number | null;
  steps: StepInput[];
}

export interface FocusView {
  task: Task | null;
  manual: boolean;
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
  offices: OfficeView[];
  lunchBreak: LunchBreak | null;
}

export interface Code {
  code: string;
  qrSvg: string;
}

/** 以 CAFECA 登入（technical-design §17）。 */
export interface SignInInfo {
  /** 確認碼 XXXX-XXXX */
  code: string;
  /** Unix 秒 */
  expiresAt: number;
  /** 登入連結的 QR（SVG） */
  qrSvg: string;
}

export type OnboardStepName =
  'signin' | 'device' | 'approval' | 'created' | 'linked' | 'denied' | 'expired';

export interface OnboardStatus {
  step: OnboardStepName;
  handle: string | null;
}

export type OnboardKind = 'create' | 'join' | 'recover';

export interface OnboardArgs {
  kind: OnboardKind;
  code: string;
  deviceName: string;
  orgName?: string;
  myName?: string;
  timezone?: string;
  locale?: string;
  teamName?: string;
}

export interface AccountView {
  address: string;
  short: string;
  handle: string | null;
}

export interface JoinRequestView {
  device: string;
  kind: 'join' | 'recover';
  memberId: string;
  name: string;
  deviceName: string;
  handle: string | null;
  account: string;
  accountShort: string;
  receivedAt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  issuedAt: number;
  thisDevice: boolean;
}

export type ConvKind = 'dm' | 'group';

export interface MessageView {
  id: string;
  conv: string;
  author: string;
  createdAt: number;
  kind: 'text' | 'files' | 'system' | string;
  body: string;
  mentions: string[];
  attachments: unknown;
}

export interface ConvRow {
  id: string;
  kind: ConvKind;
  name: string;
  creator: string;
  createdAt: number;
  members: string[];
  last: MessageView | null;
  unread: number;
}

export const EVENTS = {
  node: 'hills://node',
} as const;

type InvokeOptions = { headers: Record<string, string> };
type Invoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: InvokeOptions,
) => Promise<T>;
type Listen = <T>(event: string, cb: (payload: T) => void) => Promise<UnlistenFn>;

interface Backend {
  invoke: Invoke;
  listen: Listen;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let backend: Promise<Backend>;
if (isTauri) {
  backend = Promise.resolve({
    invoke: (cmd, args, options) => tauriInvoke(cmd, args, options),
    listen: (event, cb) => tauriListen(event, (e) => cb(e.payload as never)),
  });
} else if (import.meta.env.DEV) {
  backend = import('./dev/mockBackend').then((m) => m.mockBackend);
} else {
  backend = Promise.reject(new Error('not running inside Tauri'));
}

const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (await backend).invoke<T>(cmd, args);

/** 二進位內容 + 標頭（Tauri raw request）。 */
const callRaw = async <T>(cmd: string, body: Uint8Array, headers: Record<string, string>) =>
  (await backend).invoke<T>(cmd, body, { headers });

/** Rust 端以 tauri::ipc::Response 回傳的二進位。 */
const callBytes = async (cmd: string, args: Record<string, unknown>): Promise<Uint8Array> => {
  const r = await (await backend).invoke<ArrayBuffer | Uint8Array | number[]>(cmd, args);
  return r instanceof Uint8Array ? r : new Uint8Array(r as ArrayBuffer);
};

// ── 檔案分享（technical-design §15、D39） ──────────────────

export interface PickedFile {
  token: string;
  name: string;
  size: number;
  mtime: number | null;
}

export type FolderPickEntry =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; token: string; size: number; mtime: number | null };

export interface FolderPick {
  root: string;
  entries: FolderPickEntry[];
  skipped: { path: string; reason: 'symlink' | 'system' | 'unreadable' }[];
  totalSize: number;
  fileCount: number;
}

export interface StoredUploadJob {
  id: string;
  tokens: (string | null)[];
  state: unknown;
}

export const listen = async <T>(event: string, cb: (payload: T) => void) =>
  (await backend).listen<T>(event, cb);

/** 把後端錯誤轉為字串（Tauri command 以字串回傳錯誤）。 */
export const errorMessage = (e: unknown): string =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  resetLocalData: () => call<void>('reset_local_data'),
  onboardBegin: (args: OnboardArgs) => call<SignInInfo>('onboard_begin', { args }),
  onboardOpenLink: () => call<void>('onboard_open_link'),
  onboardPoll: () => call<OnboardStatus>('onboard_poll'),
  onboardCancel: () => call<void>('onboard_cancel'),
  exportOrgRootBackup: (password: string) => call<string>('export_org_root_backup', { password }),
  overview: () => call<Overview>('overview'),
  /** 只改狀態與文字（保留回來時間與地點），供閒置自動暫離使用。 */
  setPresence: (presence: PresenceState, note: string) =>
    call<void>('set_presence', { presence, note }),
  setPresenceFull: (
    presence: PresenceState,
    note: string,
    until: number | null,
    location: LocationCode,
  ) => call<void>('set_presence', { presence, note, until, location }),
  tasks: () => call<Task[]>('tasks'),
  createTask: (team: string, input: TaskInput) => call<string>('create_task', { team, input }),
  updateTask: (team: string, task: string, input: TaskInput) =>
    call<void>('update_task', { team, task, input }),
  setStepDone: (team: string, task: string, step: string, done: boolean) =>
    call<void>('set_step_done', { team, task, step, done }),
  deleteTask: (team: string, task: string) => call<void>('delete_task', { team, task }),
  focus: () => call<FocusView>('focus'),
  setFocus: (team: string | null, task: string | null) => call<void>('set_focus', { team, task }),
  setProfile: (look: Look) => call<void>('set_profile', { look }),
  upsertOffice: (id: string | null, name: string) => call<string>('upsert_office', { id, name }),
  removeOffice: (id: string) => call<void>('remove_office', { id }),
  setLunchBreak: (start: string, end: string) => call<void>('set_lunch_break', { start, end }),
  pickFiles: () => call<PickedFile[]>('pick_files'),
  pickFolder: () => call<FolderPick | null>('pick_folder'),
  readStripe: (token: string, offset: number, len: number) =>
    callBytes('read_stripe', { token, offset, len }),
  storageNodes: () => call<number[]>('storage_nodes'),
  putShard: (node: number, id: string, data: Uint8Array) =>
    callRaw<void>('put_shard', data, { 'x-node': String(node), 'x-id': id }),
  hasShards: (node: number, ids: string[]) => call<boolean[]>('has_shards', { node, ids }),
  getShard: (node: number, id: string) => callBytes('get_shard', { node, id }),
  saveTargetFile: (name: string) => call<string | null>('save_target_file', { name }),
  saveTargetFolder: () => call<{ token: string; name: string } | null>('save_target_folder'),
  writePartial: (token: string, path: string, offset: number, data: Uint8Array) =>
    callRaw<void>('write_partial', data, {
      'x-token': token,
      'x-path': encodeURIComponent(path),
      'x-offset': String(offset),
    }),
  finishDownload: (token: string, path: string, size: number) =>
    call<string>('finish_download', { token, path, size }),
  abortDownload: (token: string, path: string) => call<void>('abort_download', { token, path }),
  showDownload: (token: string, path: string, name: string, open: boolean) =>
    call<void>('show_download', { token, path, name, open }),
  saveUploadJobs: (jobs: { id: string; tokens: string[]; state: unknown }[]) =>
    call<void>('save_upload_jobs', { jobs }),
  uploadJobs: () => call<StoredUploadJob[]>('upload_jobs'),
  syncStatus: () => call<SyncStatus | null>('sync_status'),
  syncNow: () => call<void>('sync_now'),
  orgCode: () => call<Code>('org_code'),
  cafecaAccount: () => call<AccountView | null>('cafeca_account'),
  pendingJoins: () => call<JoinRequestView[]>('pending_joins'),
  approveJoin: (device: string, admin: boolean, teams: string[]) =>
    call<void>('approve_join', { device, admin, teams }),
  rejectJoin: (device: string) => call<void>('reject_join', { device }),
  renameOrg: (name: string) => call<void>('rename_org', { name }),
  revokeMember: (memberId: string) => call<void>('revoke_member', { memberId }),
  devices: () => call<DeviceInfo[]>('devices'),
  revokeDevice: (deviceId: string) => call<void>('revoke_device', { deviceId }),
  conversations: () => call<ConvRow[]>('conversations'),
  messages: (conv: string, limit?: number) => call<MessageView[]>('messages', { conv, limit }),
  openDm: (member: string) => call<string>('open_dm', { member }),
  createGroup: (name: string, members: string[]) => call<string>('create_group', { name, members }),
  sendMessage: (conv: string, body: string, mentions: string[], attachments?: unknown) =>
    call<MessageView>('send_message', { conv, body, mentions, attachments }),
  addConvMembers: (conv: string, members: string[]) =>
    call<void>('add_conv_members', { conv, members }),
  removeConvMember: (conv: string, member: string) =>
    call<void>('remove_conv_member', { conv, member }),
  renameConv: (conv: string, name: string) => call<void>('rename_conv', { conv, name }),
  setActiveConv: (conv: string | null, readUntil?: number) =>
    call<void>('set_active_conv', { conv, readUntil }),
};
