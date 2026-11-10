/**
 * 與 Rust 端（hills-node）溝通的唯一入口。前端不接觸金鑰，只呼叫 command、接收事件。
 * 在瀏覽器（非 Tauri）開發時使用 dev/mockBackend 的假資料，正式建置不包含。
 */
import type { DocFormat } from './doc-spec';
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
  /** 角色種類 0–6（男性、女性、貓、狗、大象、羊、老虎；D56）；舊資料沒有時視為 0 */
  kind: number;
  /** 部位 1 色號 0–5（頭髮 / 毛色 / 皮膚 / 羊毛） */
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
  /** 顯示名稱（個人資料優先，否則名冊姓名；D57） */
  name: string;
  /** 組織名冊上的姓名 */
  rosterName: string;
  isAdmin: boolean;
  isMe: boolean;
  joinedAt: number;
  presence: PresenceState | null;
  note: string;
  /** 回來時間（ms） */
  until: number | null;
  location: LocationCode;
  look: Look | null;
  /** 前端依對方的工作時段計算（D57，technical-design §16.17）；後端不回傳 */
  offHours?: boolean;
}

/** 工作時段（technical-design §16.17）：days 1 = 週一 … 7 = 週日。 */
export interface WorkHours {
  days: number[];
  start: string;
  end: string;
}

/** 個人資料（D57）。displayName / timezone 空字串表示沿用名冊姓名 / 裝置時區。 */
export interface MemberProfile {
  displayName: string;
  timezone: string;
  workHours: WorkHours;
  updatedAt: number;
}

export interface MemberProfileView extends MemberProfile {
  member: string;
}

/** 通知偏好（D57）；新裝置加入的安全通知不受影響。 */
export interface NotifyPrefs {
  messages: boolean;
  assigned: boolean;
  blockers: boolean;
  scrumReminder: boolean;
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
  /** 預估分鐘數（D62） */
  estimate?: number | null;
}

/** 卡住中（D60）：最新一筆未解決的「卡住了」。 */
export interface TaskBlocked {
  log: string;
  author: string;
  text: string;
  since: number;
}

export interface Task {
  id: string;
  team: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
  dueAt: number | null;
  /** 改成完成的時間（D47 方向摘要） */
  doneAt: number | null;
  steps: TaskStep[];
  /** 所屬週目標（D46） */
  planItemId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** 指派者與時間（負責人改變時寫入，D50） */
  assignedBy: string | null;
  assignedAt: number | null;
  /** 來源小組目標（D50） */
  teamGoalId: string | null;
  /** 目前負責人有效的回應（D50） */
  ack: TaskAck | null;
  /** 待接下：別人指派、還沒接下（D50） */
  pendingAck: boolean;
  /** 交付說明（Markdown，D53） */
  brief: string | null;
  /** 完成條件（D53） */
  acceptance: Criterion[];
  /** 預估分鐘數（D62） */
  estimate?: number | null;
  /** 負責人最新回報的百分比（D60） */
  reported?: number | null;
  /** 卡住中（D60） */
  blocked?: TaskBlocked | null;
}

/** 任務的一條完成條件（D53）。 */
export interface Criterion {
  id: string;
  text: string;
}

export type LogKind =
  | 'start'
  | 'progress'
  | 'question'
  | 'answer'
  | 'close'
  | 'reopen'
  | 'step'
  | 'blocked'
  | 'resolved';

/** 我寫的一筆紀錄與所屬任務（每日任務草稿，D60）。 */
export interface MyLog {
  team: string;
  task: string;
  title: string;
  log: TaskLog;
}

/** 一筆執行紀錄（technical-design §16.8 v0.29，D53）。 */
export interface TaskLog {
  id: string;
  author: string;
  kind: LogKind;
  text: string;
  percent: number | null;
  refs: string[];
  at: number;
}

export interface CriterionResult {
  id: string;
  met: boolean;
  note?: string | null;
}

/** 結案報告（hills-doc/1 結案報告規格，D53）。 */
export interface TaskReport {
  v: number;
  format: DocFormat;
  spec: string;
  body: string;
  criteria: CriterionResult[];
  /** §14.2 Attachment 陣列 */
  attachments: unknown[];
  at: number;
  author: string | null;
}

export interface CloseInput {
  format: DocFormat;
  body: string;
  criteria: CriterionResult[];
  attachments: unknown[];
  refs?: string[];
}

export type AckState = 'accepted' | 'concern';

export interface TaskAck {
  state: AckState;
  note?: string;
  at: number;
}

export interface StepInput {
  id?: string | null;
  title: string;
  assignee: string | null;
  done: boolean;
  /** 預估分鐘數；不傳 = 沿用，0 = 清除（D62） */
  estimate?: number | null;
}

export interface TaskInput {
  title: string;
  assignee: string | null;
  status?: TaskStatus | null;
  dueAt: number | null;
  steps: StepInput[];
  planItemId?: string | null;
  /** 來源小組目標（D50） */
  teamGoalId?: string | null;
  /** 交付說明；不傳 = 不變更，空字串 = 清除（D53） */
  brief?: string | null;
  /** 完成條件；不傳 = 不變更（D53） */
  acceptance?: { id?: string | null; text: string }[] | null;
  /** 預估分鐘數；不傳 = 不變更，0 = 清除（D62） */
  estimate?: number | null;
}

/** 私人任務的「小組」值（technical-design §16.8 v0.19，D46）。 */
export const PRIVATE_TEAM = 'private';
export const isPrivateTask = (t: { team: string }) => t.team === PRIVATE_TEAM;

/**
 * 任務進度 0–100（technical-design §16.8 v0.34，D60）：完成 = 100；
 * 否則取完成步驟比例與負責人最新回報百分比較大者。
 */
export function taskProgress(
  t: Pick<Task, 'steps' | 'status'> & { reported?: number | null },
): number {
  if (t.status === 'done') return 100;
  const steps =
    t.steps.length === 0 ? 0 : (t.steps.filter((s) => s.done).length * 100) / t.steps.length;
  return Math.max(steps, t.reported ?? 0);
}

export interface FocusView {
  task: Task | null;
  manual: boolean;
}

export interface TeamView {
  id: string;
  name: string;
  members: string[];
  /** 負責人（D47：可設定小組目標） */
  leads: string[];
}

/** 小組卡（ui-spec「設定 → 小組」，D49） */
export interface TeamInfo {
  id: string;
  name: string;
  members: string[];
  leads: string[];
  archived: boolean;
  /** 本人是成員卻還沒收到小組金鑰 */
  awaitingKey: boolean;
  /** 本人可管理成員與負責人（管理者或該小組負責人） */
  canManage: boolean;
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

export interface Criterion {
  id: string;
  text: string;
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
  /** 對齊的公司方向或小組目標（年 / 季，D47） */
  alignedGoalId: string | null;
  /** 做到的標準（年 / 季，D47；純文字，不影響進度） */
  criteria: Criterion[];
  /** 季目標幫助達成上層的哪些標準（criterion id） */
  helps: string[];
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
  /** v0.29（D52） */
  format: DocFormat;
  spec: string | null;
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
  format?: DocFormat;
  spec?: string | null;
  tags: string[];
  topicId: string;
  refs: string[];
  source?: KbSource | null;
}

// ── 每日 Scrum（technical-design §16.12）──

export type ScrumRef =
  | {
      kind: 'task';
      teamId: string;
      taskId: string;
      title: string;
      /** 引用的任務紀錄 id（v2，D60） */
      log?: string | null;
      percent?: number | null;
    }
  | { kind: 'plan'; planId: string; title: string }
  | { kind: 'text'; title: string };

export interface ScrumBlocker {
  text: string;
  notified: string[];
}

/** 每日任務的「卡住了」（v2，D60）。 */
export interface ScrumBlocked {
  log: string | null;
  teamId?: string | null;
  taskId?: string | null;
  title: string;
  text: string;
  since: number;
}

export interface ScrumReport {
  member: string;
  date: string;
  done: ScrumRef[];
  today: ScrumRef[];
  blockers: ScrumBlocker[];
  blocked: ScrumBlocked[];
  note: string | null;
  submittedAt: number;
  updatedAt: number;
}

export interface ScrumInput {
  date: string;
  done: ScrumRef[];
  today: ScrumRef[];
  /** v1 的文字阻礙（介面不再新增） */
  blockers: string[];
  blocked: ScrumBlocked[];
  note?: string | null;
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

// ── 日 / 週報（technical-design §16.13）──

export type ReportKind = 'daily' | 'weekly';

export interface ReportSections {
  progress: string;
  okr: string;
  attendance: string;
  next: string;
}

export interface Report {
  member: string;
  kind: ReportKind;
  period: string;
  sections: ReportSections;
  publishedTo: string[];
  generatedAt: number;
  publishedAt: number;
  editedAt: number | null;
}

export interface ReportInput {
  kind: ReportKind;
  period: string;
  sections: ReportSections;
  publishedTo: string[];
  generatedAt?: number | null;
}

export interface ReportMine {
  report: Report | null;
  draft: string | null;
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
  alignedGoalId?: string | null;
  criteria?: Criterion[];
  helps?: string[];
  visibility: Visibility;
}

// ── 團隊方向（technical-design §16.14，D47）──

export interface Direction {
  id: string;
  year: string;
  title: string;
  keyResults: KeyResult[];
  createdAt: number;
  updatedAt: number;
  progress: number;
}

export interface TeamGoal {
  id: string;
  team: string;
  year: string;
  title: string;
  directionId: string | null;
  keyResults: KeyResult[];
  criteria: Criterion[];
  createdAt: number;
  updatedAt: number;
  progress: number;
}

export interface DirectionsView {
  directions: Direction[];
  teamGoals: TeamGoal[];
}

// ── 方向摘要與偏離（technical-design §16.14 v0.21，D47 第 2 批）──

export interface GoalBrief {
  id: string;
  title: string;
  progress: number;
  alignedGoalId: string | null;
}

export interface DirectionWeek {
  v?: number;
  week: string;
  units: number;
  alignedUnits: number;
  quarterProgress: number | null;
  goals: GoalBrief[];
  privateGoals: number;
  lastActivity: number;
  openTasks: number;
  dueThisWeek: number;
  updatedAt: number;
}

export interface MemberDirection {
  member: string;
  /** 由新到舊 */
  weeks: DirectionWeek[];
}

export interface SuggestionView {
  id: string;
  from: string;
  planItemId: string;
  goalId: string;
  createdAt: number;
}

export interface DirectionRules {
  minAlignedShare: number;
  behindPoints: number;
  staleDays: number;
}

export interface WeekNote {
  team: string;
  week: string;
  text: string;
  author: string;
  updatedAt: number;
}

export interface DirectionInput {
  id?: string | null;
  year: string;
  title: string;
  keyResults: KeyResult[];
}

export interface TeamGoalInput {
  id?: string | null;
  team: string;
  year: string;
  title: string;
  directionId: string | null;
  keyResults: KeyResult[];
  criteria: Criterion[];
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
  /** 本機 MCP：有新的待確認變更或設定改變（technical-design §18.4） */
  mcp: 'hills://mcp',
} as const;

// ── 本機 MCP 介面（D48，technical-design §18） ─────────────────

export interface McpSettings {
  /** 組織是否允許 */
  allowed: boolean;
  isAdmin: boolean;
  enabled: boolean;
  running: boolean;
  port: number;
  endpoint: string;
  /** 開啟後才有 */
  token: string | null;
  error: string | null;
}

export type McpChangeStatus =
  { state: 'pending' | 'approved' | 'rejected' | 'expired' } | { state: 'failed'; error: string };

/** 確認卡的預覽（文字由前端依 i18n 組成） */
export interface McpPreview {
  action:
    | 'createGoal'
    | 'updateGoal'
    | 'createTask'
    | 'updateTask'
    | 'stepDone'
    | 'scrumDraft'
    | 'message'
    | 'createKb'
    | 'updateKb'
    | 'deleteGoal'
    | 'deleteTask'
    | 'deleteKb'
    | 'createTeamGoal'
    | 'updateTeamGoal'
    | 'deleteTeamGoal'
    | 'weekNote'
    | 'createDirection'
    | 'updateDirection'
    | 'deleteDirection'
    | 'taskStatus'
    | 'taskAck'
    | 'createTeam'
    | 'updateTeam'
    | 'archiveTeam'
    | 'unarchiveTeam'
    | 'createKbCategory'
    | 'createKbTopic'
    | 'renameKb'
    | 'taskLog'
    | 'closeTask'
    | 'reopenTask';
  title?: string | null;
  level?: PlanLevel | null;
  period?: string | null;
  team?: string | null;
  assignee?: string | null;
  dueAt?: number | null;
  task?: string | null;
  step?: string | null;
  done?: boolean | null;
  date?: string | null;
  text?: string | null;
  conv?: string | null;
  planItemId?: string | null;
  status?: TaskStatus | null;
  /** 私訊對象（memberId） */
  to?: string | null;
  /** 群組人數、小組成員數 */
  count?: number | null;
  /** 修改小組時被移出的成員（會輪替小組金鑰） */
  removed?: string[] | null;
  leads?: string[] | null;
  state?: 'accepted' | 'concern' | null;
  kind?: 'category' | 'topic' | LogKind | null;
  percent?: number | null;
  from?: string | null;
  parent?: string | null;
}

export interface McpChange {
  id: string;
  client: string;
  tool: string;
  preview: McpPreview;
  createdAt: number;
  status: McpChangeStatus;
}

export interface McpAuditEntry {
  at: number;
  client: string;
  tool: string;
  outcome: 'read' | 'pending' | 'approved' | 'rejected' | 'denied' | 'error';
}

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

/**
 * 第一次呼叫時才決定後端：Tauri 內用 IPC；瀏覽器開發模式載入 mock。
 * 延後載入讓單元測試（Node，沒有 window）匯入本檔時不會去載 mock。
 */
let backendPromise: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  backendPromise ??= isTauri
    ? Promise.resolve({
        invoke: (cmd, args, options) => tauriInvoke(cmd, args, options),
        listen: (event, cb) => tauriListen(event, (e) => cb(e.payload as never)),
      })
    : import.meta.env.DEV && typeof window !== 'undefined'
      ? import('./dev/mockBackend').then((m) => m.mockBackend)
      : Promise.reject(new Error('not running inside Tauri'));
  return backendPromise;
}

const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (await backend()).invoke<T>(cmd, args);

/** 二進位內容 + 標頭（Tauri raw request）。 */
const callRaw = async <T>(cmd: string, body: Uint8Array, headers: Record<string, string>) =>
  (await backend()).invoke<T>(cmd, body, { headers });

/** Rust 端以 tauri::ipc::Response 回傳的二進位。 */
const callBytes = async (cmd: string, args: Record<string, unknown>): Promise<Uint8Array> => {
  const r = await (await backend()).invoke<ArrayBuffer | Uint8Array | number[]>(cmd, args);
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
  (await backend()).listen<T>(event, cb);

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
  taskLogs: (team: string, task: string) => call<TaskLog[]>('task_logs', { team, task }),
  addTaskLog: (team: string, task: string, kind: LogKind, text: string, percent: number | null) =>
    call<void>('add_task_log', { team, task, kind, text, percent }),
  resolveTaskBlocked: (team: string, task: string, blocked: string, text: string) =>
    call<void>('resolve_task_blocked', { team, task, blocked, text }),
  myLogsSince: (since: number) => call<MyLog[]>('my_logs_since', { since }),
  closeTask: (team: string, task: string, input: CloseInput) =>
    call<void>('close_task', { team, task, input }),
  reopenTask: (team: string, task: string, text: string) =>
    call<void>('reopen_task', { team, task, text }),
  taskReport: (team: string, task: string) =>
    call<TaskReport | null>('task_report', { team, task }),
  setStepDone: (team: string, task: string, step: string, done: boolean) =>
    call<void>('set_step_done', { team, task, step, done }),
  deleteTask: (team: string, task: string) => call<void>('delete_task', { team, task }),
  plans: (mineOnly: boolean) => call<PlanView[]>('plans', { mineOnly }),
  setTaskAck: (team: string, task: string, ack: AckState, note: string | null) =>
    call<void>('set_task_ack', { team, task, ack, note }),
  savePlan: (input: PlanInput) => call<string>('save_plan', { input }),
  setPlanDone: (id: string, done: boolean) => call<void>('set_plan_done', { id, done }),
  deletePlan: (id: string) => call<void>('delete_plan', { id }),
  directions: () => call<DirectionsView>('directions'),
  saveDirection: (input: DirectionInput) => call<string>('save_direction', { input }),
  deleteDirection: (id: string) => call<void>('delete_direction', { id }),
  saveTeamGoal: (input: TeamGoalInput) => call<string>('save_team_goal', { input }),
  deleteTeamGoal: (team: string, id: string) => call<void>('delete_team_goal', { team, id }),
  weekNotes: () => call<WeekNote[]>('week_notes'),
  mcpSettings: () => call<McpSettings>('mcp_settings'),
  setMcpEnabled: (enabled: boolean) => call<void>('set_mcp_enabled', { enabled }),
  regenerateMcpToken: () => call<string>('regenerate_mcp_token'),
  setMcpAllowed: (allowed: boolean) => call<void>('set_mcp_allowed', { allowed }),
  mcpPending: () => call<McpChange[]>('mcp_pending'),
  mcpApprove: (id: string) => call<unknown>('mcp_approve', { id }),
  mcpReject: (id: string) => call<void>('mcp_reject', { id }),
  mcpAudit: () => call<McpAuditEntry[]>('mcp_audit'),
  setWeekNote: (team: string, week: string, text: string) =>
    call<void>('set_week_note', { team, week, text }),
  directionSummaries: () => call<MemberDirection[]>('direction_summaries'),
  mySuggestions: () => call<SuggestionView[]>('my_suggestions'),
  publishDirection: (week: DirectionWeek) => call<void>('publish_direction', { week }),
  suggestAlign: (to: string, planItemId: string, goalId: string) =>
    call<void>('suggest_align', { to, planItemId, goalId }),
  directionRules: () => call<DirectionRules>('direction_rules'),
  setDirectionRules: (rules: DirectionRules) => call<void>('set_direction_rules', { rules }),
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
  reportMine: (kind: ReportKind, period: string) =>
    call<ReportMine>('report_mine', { kind, period }),
  reportPublish: (input: ReportInput) => call<Report>('report_publish', { input }),
  reportTeam: (team: string, kind: ReportKind, period: string) =>
    call<Report[]>('report_team', { team, kind, period }),
  reportDraftSet: (kind: ReportKind, period: string, draft: string | null) =>
    call<void>('report_draft_set', { kind, period, draft }),
  reportRemind: (week: string, title: string, body: string) =>
    call<boolean>('report_remind', { week, title, body }),
  exportText: (name: string, content: string) => call<boolean>('export_text', { name, content }),
  focus: () => call<FocusView>('focus'),
  setFocus: (team: string | null, task: string | null) => call<void>('set_focus', { team, task }),
  setProfile: (look: Look) => call<void>('set_profile', { look }),
  myProfile: () => call<MemberProfile>('my_profile'),
  setMyProfile: (profile: MemberProfile) => call<void>('set_my_profile', { profile }),
  memberProfiles: () => call<MemberProfileView[]>('member_profiles'),
  notifyPrefs: () => call<NotifyPrefs>('notify_prefs'),
  setNotifyPrefs: (prefs: NotifyPrefs) => call<void>('set_notify_prefs', { prefs }),
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
  appVersion: () => call<{ version: string; commit: string }>('app_version'),
  syncStatus: () => call<SyncStatus | null>('sync_status'),
  syncNow: () => call<void>('sync_now'),
  orgCode: () => call<Code>('org_code'),
  cafecaAccount: () => call<AccountView | null>('cafeca_account'),
  pendingJoins: () => call<JoinRequestView[]>('pending_joins'),
  approveJoin: (device: string, admin: boolean, teams: string[]) =>
    call<void>('approve_join', { device, admin, teams }),
  rejectJoin: (device: string) => call<void>('reject_join', { device }),
  teamsInfo: () => call<TeamInfo[]>('teams_info'),
  createTeam: (name: string, members: string[], leads: string[]) =>
    call<string>('create_team', { name, members, leads }),
  renameTeam: (id: string, name: string) => call<void>('rename_team', { id, name }),
  archiveTeam: (id: string, archived: boolean) => call<void>('archive_team', { id, archived }),
  setTeamMembers: (id: string, members: string[], leads: string[]) =>
    call<void>('set_team_members', { id, members, leads }),
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
