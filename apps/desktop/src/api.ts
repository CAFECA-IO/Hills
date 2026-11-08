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
  /** debug 建置：可用測試帳號登入（D44，technical-design §17.10） */
  devLogin: boolean;
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
  /** 組織時區（IANA），計劃期間依此計算 */
  timezone: string;
}

// ── 目標（五層計劃，technical-design §16.10）──

export type PlanLevel = 'year' | 'quarter' | 'month' | 'week' | 'day';

export type Visibility = { kind: 'private' } | { kind: 'org' } | { kind: 'team'; team: string };

export interface KeyResult {
  id: string;
  title: string;
  start: number;
  target: number;
  current: number;
  unit: string;
  manual: boolean;
}

export interface PlanView {
  id: string;
  owner: string;
  visibility: Visibility;
  level: PlanLevel;
  period: string;
  title: string;
  parentId: string | null;
  krRef: string | null;
  done: boolean;
  progressOverride: number | null;
  keyResults: KeyResult[];
  createdAt: number;
  updatedAt: number;
  /** 彙總後的進度 0–100 */
  progress: number;
  krProgress: Record<string, number>;
  mine: boolean;
}

// ── 知識庫（technical-design §16.11）──

export interface KbCategory {
  id: string;
  name: string;
  createdAt: number;
  /** 合併後的最終分類 */
  resolved: string;
}

export interface KbTopic {
  id: string;
  name: string;
  categoryId: string;
  createdAt: number;
  resolved: string;
}

export type KbSource =
  | { kind: 'manual' }
  | { kind: 'message'; convId: string; messageKey: string }
  | { kind: 'file'; convId: string; attachment: unknown }
  | { kind: 'task'; teamId: string; taskId: string };

export interface KbItem {
  /** `<作者>:<ULID>` */
  key: string;
  author: string;
  title: string;
  body: string;
  tags: string[];
  topicId: string;
  refs: string[];
  source: KbSource;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface KbSnapshot {
  categories: KbCategory[];
  topics: KbTopic[];
  items: KbItem[];
}

export interface KbInput {
  key?: string | null;
  title: string;
  body: string;
  tags: string[];
  topicId: string;
  refs: string[];
  source?: KbSource | null;
}

// ── 每日 Scrum（technical-design §16.12）──

export type ScrumRef =
  | { kind: 'task'; teamId: string; taskId: string; title: string }
  | { kind: 'plan'; planId: string; title: string }
  | { kind: 'text'; title: string };

export interface ScrumBlocker {
  text: string;
  notified: string[];
}

export interface ScrumReport {
  member: string;
  date: string;
  done: ScrumRef[];
  today: ScrumRef[];
  blockers: ScrumBlocker[];
  submittedAt: number;
  updatedAt: number;
}

export interface ScrumInput {
  date: string;
  done: ScrumRef[];
  today: ScrumRef[];
  blockers: string[];
}

export interface ScrumMine {
  report: ScrumReport | null;
  /** 本機草稿（ScrumInput 的 JSON） */
  draft: string | null;
  /** 阻礙會通知的成員 */
  notify: string[];
}

export interface ScrumReminder {
  org: string;
  mine: string | null;
}

export interface PlanInput {
  id?: string | null;
  level: PlanLevel;
  period: string;
  title: string;
  parentId: string | null;
  krRef: string | null;
  done: boolean;
  progressOverride: number | null;
  keyResults: KeyResult[];
  visibility: Visibility;
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
  /** 開發測試模式的測試帳號名稱（D44）；未填為正式 CAFECA 登入 */
  devAccount?: string;
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
  /** kind = 'task'：連結的任務，null = 取消連結（technical-design §14.2 v0.14） */
  task?: TaskRefView | null;
}

/** 對話連結的任務。 */
export interface TaskRefView {
  team: string;
  id: string;
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
  /** 對話目前連結的任務（焦點營地） */
  task: TaskRefView | null;
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
  plans: (mineOnly: boolean) => call<PlanView[]>('plans', { mineOnly }),
  savePlan: (input: PlanInput) => call<string>('save_plan', { input }),
  setPlanDone: (id: string, done: boolean) => call<void>('set_plan_done', { id, done }),
  deletePlan: (id: string) => call<void>('delete_plan', { id }),
  kb: () => call<KbSnapshot>('kb'),
  kbSave: (input: KbInput) => call<string>('kb_save', { input }),
  kbDelete: (key: string) => call<void>('kb_delete', { key }),
  kbCreateCategory: (name: string) => call<string>('kb_create_category', { name }),
  kbCreateTopic: (category: string, name: string) =>
    call<string>('kb_create_topic', { category, name }),
  kbRename: (kind: 'category' | 'topic', id: string, name: string) =>
    call<void>('kb_rename', { kind, id, name }),
  kbMerge: (kind: 'category' | 'topic', from: string, into: string) =>
    call<void>('kb_merge', { kind, from, into }),
  kbFromMessage: (
    conv: string,
    messageKey: string,
    topic: string,
    title: string,
    attachment: number | null,
  ) => call<string>('kb_from_message', { conv, messageKey, topic, title, attachment }),
  scrumMine: (date: string) => call<ScrumMine>('scrum_mine', { date }),
  scrumSubmit: (input: ScrumInput) => call<ScrumReport>('scrum_submit', { input }),
  scrumTeam: (team: string, from: string, to: string) =>
    call<ScrumReport[]>('scrum_team', { team, from, to }),
  scrumDraftSet: (date: string, draft: string | null) =>
    call<void>('scrum_draft_set', { date, draft }),
  scrumReminder: () => call<ScrumReminder>('scrum_reminder'),
  setMyScrumReminder: (hhmm: string | null) => call<void>('set_my_scrum_reminder', { hhmm }),
  setOrgScrumReminder: (hhmm: string) => call<void>('set_org_scrum_reminder', { hhmm }),
  scrumRemind: (date: string, title: string, body: string) =>
    call<boolean>('scrum_remind', { date, title, body }),
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
  setConvTask: (conv: string, link: TaskRefView | null) =>
    call<void>('set_conv_task', { conv, team: link?.team ?? null, task: link?.id ?? null }),
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
