/**
 * 開發用假後端：在瀏覽器（非 Tauri）預覽畫面時使用，只在 dev build 載入。
 * 資料皆為虛構示範內容。CAFECA 登入以計時模擬（`?signin=device` 模擬新增裝置、`?signin=denied` 模擬拒絕）。
 */
import type {
  AppInfo,
  Code,
  DeviceInfo,
  JoinRequestView,
  MemberProfile,
  MemberView,
  NotifyPrefs,
  CloseInput,
  LogKind,
  TaskLog,
  TaskReport,
  OnboardArgs,
  OnboardStatus,
  Overview,
  TeamInfo,
  KbCategory,
  KbInput,
  KbItem,
  KbTopic,
  Direction,
  DirectionInput,
  DirectionRules,
  DirectionWeek,
  GoalBrief,
  MemberDirection,
  SuggestionView,
  PlanInput,
  PlanView,
  TeamGoal,
  TeamGoalInput,
  WeekNote,
  McpChange,
  McpAuditEntry,
  Report,
  ReportInput,
  ScrumInput,
  ScrumReport,
  PresenceState,
} from '../api';
import { periodsAt } from '../goals-utils';

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();
const emit = (event: string, payload: unknown) =>
  listeners.get(event)?.forEach((cb) => cb(payload));

const QR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="220" height="220"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1zM10 10h2v2h-2zM14 14h3v3h-3z" fill="#000"/></svg>';
const code = (c: string): Code => ({ code: c, qrSvg: QR });

const params = new URLSearchParams(window.location.search);
const state = {
  phase: (params.get('phase') as AppInfo['phase']) ?? 'welcome',
  orgName: '示範組織',
  isAdmin: true,
  me: 'mem-me',
  note: '',
  presence: 'Focus' as PresenceState,
  until: (Date.now() + 50 * 60_000) as number | null,
  location: 'remote',
};

const now0 = Date.now();
const look = (hair: number, shirt: number, skin: number, kind = 0) => ({ kind, hair, shirt, skin });
const person = (
  id: string,
  name: string,
  presence: PresenceState | null,
  location: string,
  lk: ReturnType<typeof look>,
  until: number | null = null,
  note = '',
): MemberView => ({
  id,
  name,
  rosterName: name,
  isAdmin: false,
  isMe: false,
  joinedAt: 0,
  presence,
  note,
  until,
  location,
  look: lk,
});
// 示範角色（虛構人物，與設計稿第四輪相同）
const others: MemberView[] = [
  person('mem-a', '王小明', 'Online', 'office:tpe', look(0, 0, 0, 0)),
  person('mem-b', '陳小華', 'Meeting', 'office:tpe', look(1, 1, 1, 2), now0 + 50 * 60_000, '週會'),
  person('mem-c', '周子安', 'Lunch', 'office:tpe', look(2, 2, 2, 1), now0 + 50 * 60_000),
  person('mem-d', '林小美', 'Online', 'office:hsz', look(3, 3, 0, 3), null, 'Windows 驗收'),
  person('mem-e', '黃宜靜', 'Away', 'office:hsz', look(1, 4, 3, 4), now0 + 15 * 60_000),
  person('mem-f', '張大同', null, 'hidden', look(1, 5, 1, 5)),
  person('mem-g', '李雅婷', 'Leave', 'office:tpe', look(2, 0, 0, 6), now0 + 4 * 86400_000),
];
// 小組（D49）：mock 中「我」是管理者
let mockTeams: TeamInfo[] = [
  {
    id: 'default',
    name: '全體成員',
    members: [state.me, ...others.map((m) => m.id)],
    leads: [state.me],
    archived: false,
    awaitingKey: false,
    canManage: true,
  },
  {
    id: 'eng',
    name: '工程小組',
    members: [state.me, 'mem-b', 'mem-d', 'mem-f'],
    leads: ['mem-b'],
    archived: false,
    awaitingKey: true,
    canManage: true,
  },
  {
    id: 'old',
    name: '展場專案',
    members: ['mem-c', 'mem-g'],
    leads: [],
    archived: true,
    awaitingKey: false,
    canManage: true,
  },
];
let offices = [
  { id: 'tpe', name: '台北辦公室' },
  { id: 'hsz', name: '新竹辦公室' },
];
let lunchBreak: { start: string; end: string } | null = { start: '12:00', end: '13:30' };
interface MockStep {
  id: string;
  title: string;
  assignee: string | null;
  done: boolean;
  doneAt: number | null;
}
interface MockTask {
  id: string;
  team: string;
  title: string;
  assignee: string | null;
  status: string;
  dueAt: number | null;
  doneAt?: number | null;
  steps: MockStep[];
  planItemId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  // 分派（D50）
  assignedBy?: string | null;
  assignedAt?: number | null;
  teamGoalId?: string | null;
  ack?: { state: 'accepted' | 'concern'; note?: string; at: number } | null;
  // 交付說明與完成條件（D53）
  brief?: string | null;
  acceptance?: { id: string; text: string }[];
}
const st = (id: string, title: string, assignee: string | null, done = false): MockStep => ({
  id,
  title,
  assignee,
  done,
  doneAt: done ? now0 - 3600_000 : null,
});
let tasks: MockTask[] = [
  {
    id: 't1',
    team: 'default',
    title: 'Windows 驗收',
    assignee: 'mem-d',
    status: 'doing',
    dueAt: now0 + 80 * 60_000,
    steps: [
      st('s1', 'Mac 驗收', 'mem-d', true),
      st('s2', 'relay 更新', 'mem-me'),
      st('s3', '通知測試', 'mem-d'),
      st('s4', '簽核', 'mem-d'),
    ],
    planItemId: 'w1',
    createdBy: 'mem-me',
    createdAt: now0 - 4 * 3600_000,
    updatedAt: now0,
  },
  {
    id: 't2',
    team: 'default',
    title: '撰寫檔案分享部署說明',
    assignee: 'mem-me',
    status: 'todo',
    dueAt: null,
    steps: [st('s5', '草稿', 'mem-me'), st('s6', '請小明校對', 'mem-a')],
    planItemId: 'w1',
    createdBy: 'mem-me',
    createdAt: now0 - 86400_000,
    updatedAt: now0,
  },
  {
    id: 't3',
    team: 'private',
    title: '寫週報',
    assignee: 'mem-me',
    status: 'todo',
    dueAt: null,
    steps: [],
    planItemId: 'w2',
    createdBy: 'mem-me',
    createdAt: now0 - 3600_000,
    updatedAt: now0,
  }, // 還沒連到週目標（週一方向時刻示範）
  ...(
    [
      ['t4', '整理 relay 監控告警', null],
      ['t5', '回覆客戶導入問卷', now0 + 86400_000],
      ['t6', '試用新的看板外掛', null],
    ] as const
  ).map(([id, title, dueAt]): MockTask => ({
    id,
    team: 'default',
    title,
    assignee: 'mem-me',
    status: 'todo',
    dueAt,
    steps: [],
    planItemId: null,
    createdBy: 'mem-me',
    createdAt: now0 - 7200_000,
    updatedAt: now0,
  })),
  // 分派示範（D50）：我指派給別人、別人指派給我、未指派
  ...(
    [
      ['t20', 'B2 設備清單比對', 'mem-c', 'mem-me', 3, null],
      [
        't21',
        'B3 介接測試',
        'mem-c',
        'mem-me',
        4,
        { state: 'concern', note: '需要測試帳號才能開始', at: now0 },
      ],
      ['t22', '異常事件庫 v1', 'mem-b', 'mem-me', 2, { state: 'accepted', at: now0 }],
      ['t23', 'DEMO 腳本', 'mem-b', 'mem-me', 1, { state: 'accepted', at: now0 }],
      ['t24', '動畫元件庫 v1', 'mem-b', 'mem-b', 2, null],
      ['t25', '確認 A3 資料來源', 'mem-b', 'mem-b', 1, null],
      ['t26', '擴充介面規格 v0.1', null, null, 6, null],
      ['t27', '製程流程圖初稿', null, null, 1, null],
      ['t28', '設施清冊整理', 'mem-me', 'mem-b', -1, null],
      ['t29', '可觀測數據清單', 'mem-a', 'mem-me', 5, { state: 'accepted', at: now0 }],
    ] as const
  ).map(([id, title, assignee, by, days, ack]): MockTask => ({
    id,
    team: 'default',
    title,
    assignee,
    status: 'todo',
    dueAt: now0 + days * 86400_000,
    steps: [],
    planItemId: null,
    createdBy: by ?? 'mem-me',
    createdAt: now0 - 3600_000,
    updatedAt: now0,
    assignedBy: by,
    assignedAt: by ? now0 - 3600_000 : null,
    teamGoalId: 'tg-1',
    ack,
  })),
];
// 執行紀錄與結案報告（D53）
const taskLogs: (TaskLog & { task: string })[] = [
  {
    task: 't25',
    id: '1',
    author: 'mem-b',
    kind: 'start',
    text: '',
    percent: null,
    refs: [],
    at: now0 - 7200_000,
  },
  {
    task: 't25',
    id: '2',
    author: 'mem-b',
    kind: 'progress',
    text: '已聯絡兩個資料來源',
    percent: 40,
    refs: [],
    at: now0 - 3600_000,
  },
  {
    task: 't25',
    id: '3',
    author: 'mem-b',
    kind: 'question',
    text: 'A3 的 API 需要誰申請？',
    percent: null,
    refs: [],
    at: now0 - 1800_000,
  },
];
const taskReports = new Map<string, TaskReport>();
/** 待接下：別人指派、還沒接下（D50） */
const withAck = (t: MockTask) => ({
  ...t,
  assignedBy: t.assignedBy ?? null,
  assignedAt: t.assignedAt ?? null,
  teamGoalId: t.teamGoalId ?? null,
  ack: t.ack ?? null,
  brief: t.brief ?? null,
  acceptance: t.acceptance ?? [],
  pendingAck: Boolean(
    t.assignee &&
    t.assignedBy &&
    t.assignee !== t.assignedBy &&
    t.status !== 'done' &&
    t.ack?.state !== 'accepted',
  ),
});
const P = periodsAt(Date.now(), 'Asia/Taipei');
const plan = (
  id: string,
  level: PlanView['level'],
  title: string,
  progress: number,
  parentId: string | null = null,
  extra: Partial<PlanView> = {},
): PlanView => ({
  id,
  owner: 'mem-me',
  visibility: { kind: 'team', team: 'default' },
  level,
  period: P[level],
  title,
  parentId,
  krRef: null,
  done: progress === 100 && !['year', 'quarter'].includes(level),
  progressOverride: null,
  keyResults: [],
  alignedGoalId: null,
  criteria: [],
  helps: [],
  createdAt: now0,
  updatedAt: now0,
  progress,
  krProgress: {},
  mine: true,
  ...extra,
});
const kr = (
  id: string,
  title: string,
  start: number,
  target: number,
  current: number,
  unit = '',
) => ({
  id,
  title,
  start,
  target,
  current,
  unit,
  manual: true,
});
// 示範目標（虛構，與設計稿第七輪相同）
let plans: PlanView[] = [
  plan('y1', 'year', 'Hills 上線並導入全公司', 58, null, {
    alignedGoalId: 'tg-1',
    keyResults: [kr('k1', '導入人數', 0, 40, 23, '人'), kr('k2', '每週活躍率', 0, 80, 47, '%')],
    krProgress: { k1: 57.5, k2: 58.75 },
  }),
  plan('y2', 'year', '營運流程數位化', 40),
  plan('q1', 'quarter', 'M1 上線', 62, 'y1', {
    keyResults: [
      kr('k3', 'M1 功能完成', 0, 28, 18, '項'),
      kr('k4', 'Mac / Windows 驗收', 0, 2, 1, '台'),
      kr('k5', '設計定稿', 0, 4, 4, '份'),
    ],
    krProgress: { k3: 64.3, k4: 50, k5: 100 },
  }),
  plan('q2', 'quarter', '假勤規則上線', 20, 'y2'),
  plan('q3', 'quarter', '招募兩位工程師', 50, 'y1', {
    owner: 'mem-a',
    mine: false,
    keyResults: [kr('k6', '錄取', 0, 2, 1, '人')],
    krProgress: { k6: 50 },
  }),
  plan('m1', 'month', 'Mac / Windows 驗收', 70, 'q1', { krRef: 'q1/k4' }),
  plan('m2', 'month', '壓力測試', 30, 'q1'),
  plan('m3', 'month', '設計定稿', 85, 'q1', { krRef: 'q1/k5' }),
  plan('w1', 'week', '檔案分享穩定', 80, 'm1'),
  plan('w2', 'week', '對話焦點營地', 40, 'm1'),
];
// 示範公司方向與小組目標（虛構，與設計稿 D 方案相同，D47）
const THIS_YEAR = P.year;
const NEXT_YEAR = String(Number(P.year) + 1);
const dirRec = (id: string, year: string, title: string): Omit<Direction, 'progress'> => ({
  id,
  year,
  title,
  keyResults: [],
  createdAt: now0,
  updatedAt: now0,
});
let directions: Omit<Direction, 'progress'>[] = [
  dirRec('dir-1', THIS_YEAR, 'Hills 上線並導入全公司'),
  dirRec('dir-2', THIS_YEAR, '客戶回覆時間縮短一半'),
  dirRec('dir-3', NEXT_YEAR, 'Hills 成為全公司的日常工具'),
  dirRec('dir-4', NEXT_YEAR, '客戶回覆時間縮短一半'),
  dirRec('dir-5', NEXT_YEAR, '完成 ISO 27001 認證'),
];
let teamGoals: Omit<TeamGoal, 'progress'>[] = [
  {
    ...dirRec('tg-1', THIS_YEAR, 'M1、M2 準時上線'),
    team: 'default',
    directionId: 'dir-1',
    criteria: [],
  },
  {
    ...dirRec('tg-2', NEXT_YEAR, 'M2 手機版與全員導入'),
    team: 'default',
    directionId: 'dir-3',
    criteria: [],
  },
  {
    ...dirRec('tg-3', NEXT_YEAR, '技術債減半'),
    team: 'default',
    directionId: 'dir-3',
    criteria: [],
  },
];
const avgOf = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
/** 進度規則同 node 的 direction_progress（technical-design §16.14）。 */
function directionsView() {
  const list = withTaskProgress(plans);
  const aligned = (id: string) =>
    list
      .filter((p) => (p.level === 'year' || p.level === 'quarter') && p.alignedGoalId === id)
      .map((p) => p.progress);
  const goals = teamGoals.map((g) => ({ ...g, progress: avgOf(aligned(g.id)) ?? 0 }));
  return {
    directions: directions.map((d) => ({
      ...d,
      progress:
        avgOf([
          ...goals.filter((g) => g.directionId === d.id).map((g) => g.progress),
          ...aligned(d.id),
        ]) ?? 0,
    })),
    teamGoals: goals,
  };
}
// 示範方向摘要（虛構，與設計稿 D 方案相同的分布，D47 第 2 批）
const DAY = 86_400_000;
const brief = (id: string, title: string, progress: number, aligned: boolean): GoalBrief => ({
  id,
  title,
  progress,
  alignedGoalId: aligned ? 'tg-1' : null,
});
const dw = (
  units: number,
  aligned: number,
  progress: number,
  goal: GoalBrief,
  idleDays = 0,
  week = P.week,
): DirectionWeek => ({
  v: 1,
  week,
  units,
  alignedUnits: aligned,
  quarterProgress: progress,
  goals: [goal],
  privateGoals: 0,
  lastActivity: now0 - idleDays * DAY,
  openTasks: 3,
  dueThisWeek: 1,
  updatedAt: now0,
});
/** n 週前的週別（第 4 批四週軌跡示範）。 */
const weekAgo = (n: number) => periodsAt(now0 - n * 7 * DAY, 'Asia/Taipei').week;
/** 前幾週的摘要（新 → 舊）：每週 [完成件數, 對齊件數, 進度]。 */
const history = (goal: GoalBrief, rows: [number, number, number][]) =>
  rows.map(([u, a, p], i) => dw(u, a, p, goal, 0, weekAgo(i + 1)));
const qb = brief('qb', '研究 Rust GUI 框架', 50, false);
const qa = brief('qa', '檔案分享上線', 70, true);
let summaries: MemberDirection[] = [
  {
    member: 'mem-a',
    weeks: [
      dw(6, 6, 70, qa, 1),
      ...history(qa, [
        [5, 4, 62],
        [4, 3, 55],
        [6, 4, 48],
      ]),
    ],
  },
  {
    member: 'mem-b',
    // 陳小華：四週來越走越偏（83% → 56% → 33% → 20%）
    weeks: [
      dw(5, 1, 50, qb),
      ...history(qb, [
        [3, 1, 46],
        [9, 5, 40],
        [6, 5, 32],
      ]),
    ],
  },
  {
    member: 'mem-c',
    weeks: [dw(2, 2, 8, brief('qc', '假勤模組上線', 8, true), 16, `${P.year}-W01`)],
  },
  {
    member: 'mem-d',
    weeks: [
      dw(5, 4, 48, brief('qd', 'Windows 安裝檔驗收', 48, true)),
      ...history(brief('qd', 'Windows 安裝檔驗收', 40, true), [
        [4, 2, 40],
        [5, 2, 33],
      ]),
    ],
  },
  // 我：只有前幾週（本週的摘要由前端發佈）
  {
    member: 'mem-me',
    weeks: history(brief('q2', '本季目標', 40, true), [
      [5, 3, 40],
      [4, 2, 34],
      [6, 2, 28],
    ]),
  },
  { member: 'mem-e', weeks: [dw(5, 4, 45, brief('qe', '聊天功能完成', 45, true), 2)] },
  { member: 'mem-f', weeks: [dw(10, 7, 40, brief('qf', '效能壓力測試', 40, true))] },
  { member: 'mem-g', weeks: [dw(10, 9, 55, brief('qg', 'iroh 連線穩定', 55, true), 1)] },
];
const suggestionsToMe: SuggestionView[] = [
  { id: 'sg-1', from: 'mem-a', planItemId: 'q2', goalId: 'tg-1', createdAt: now0 - 3600_000 },
];
const mcp: {
  allowed: boolean;
  enabled: boolean;
  token: string;
  pending: McpChange[];
  audit: McpAuditEntry[];
} = {
  allowed: true,
  enabled: true,
  token: 'DEMO7Q4K2M9XWZ3B',
  pending: [
    {
      id: 'mcp-1',
      client: 'Claude Code',
      tool: 'propose_task',
      preview: {
        action: 'createTask',
        team: 'default',
        title: '匯入台灣行事曆',
        assignee: 'mem-d',
        dueAt: now0 + 4 * 86_400_000,
        planItemId: null,
        status: null,
      },
      createdAt: now0 - 60_000,
      status: { state: 'pending' },
    },
    {
      id: 'mcp-2',
      client: 'Claude Code',
      tool: 'propose_message',
      preview: {
        action: 'message',
        conv: '',
        to: 'mem-d',
        count: 2,
        text: '這週先把假日曆匯入做完，林小美負責，週五前請 Luphia 驗收。',
      },
      createdAt: now0 - 30_000,
      status: { state: 'pending' },
    },
    {
      id: 'mcp-3',
      client: 'Claude Code',
      tool: 'propose_delete_goal',
      preview: { action: 'deleteGoal', period: '2026-W46', title: '對話焦點營地' },
      createdAt: now0 - 10_000,
      status: { state: 'pending' },
    },
    {
      id: 'mcp-4',
      client: 'Claude Code',
      tool: 'propose_team',
      preview: {
        action: 'updateTeam',
        team: '工程小組',
        title: '工程小組',
        count: 3,
        leads: ['mem-a'],
        removed: ['mem-d'],
      },
      createdAt: now0 - 5_000,
      status: { state: 'pending' },
    },
  ],
  audit: [
    { at: now0 - 30_000, client: 'Claude Code', tool: 'propose_message', outcome: 'pending' },
    { at: now0 - 60_000, client: 'Claude Code', tool: 'propose_task', outcome: 'pending' },
    { at: now0 - 90_000, client: 'Claude Code', tool: 'list_goals', outcome: 'read' },
    { at: now0 - 95_000, client: 'Claude Code', tool: 'whoami', outcome: 'read' },
  ],
};
let weekNotes: WeekNote[] = [
  {
    team: 'default',
    week: P.week,
    text: '全力 M1 驗收：檔案分享先過關',
    author: 'mem-me',
    updatedAt: now0,
  },
];
let driftRules: DirectionRules = { minAlignedShare: 50, behindPoints: 25, staleDays: 14 };
const taskProgress = (t: MockTask) =>
  t.steps.length === 0
    ? t.status === 'done'
      ? 100
      : 0
    : (t.steps.filter((x) => x.done).length * 100) / t.steps.length;
/** 週目標有任務時，進度 = 任務進度平均（D46，與 node 的 rollup 相同）。 */
const withTaskProgress = (list: PlanView[]): PlanView[] =>
  list.map((p) => {
    if (p.level !== 'week' || p.progressOverride !== null) return p;
    const linked = tasks.filter((t) => t.planItemId === p.id);
    if (linked.length === 0) return p;
    const avg = linked.reduce((n, t) => n + taskProgress(t), 0) / linked.length;
    return { ...p, progress: avg };
  });
// 示範知識庫（虛構，與設計稿第八輪相同的分類）
const kbCats: KbCategory[] = [
  ['c-prod', '產品'],
  ['c-eng', '工程'],
  ['c-ops', '部署'],
  ['c-hr', '假勤人事'],
  ['c-design', '設計'],
].map(([id, name], i) => ({
  id: id!,
  name: name!,
  createdAt: now0 - (60 - i) * 86400_000,
  resolved: id!,
}));
const kbTopics: KbTopic[] = [
  ['t-onb', 'c-prod', '引導流程'],
  ['t-goal', 'c-prod', '目標'],
  ['t-store', 'c-eng', '儲存'],
  ['t-sync', 'c-eng', '同步'],
  ['t-crypto', 'c-eng', '加密'],
  ['t-relay', 'c-ops', 'relay'],
  ['t-docker', 'c-ops', 'Docker'],
  ['t-leave', 'c-hr', '請假'],
  ['t-vis', 'c-design', '視覺語言'],
].map(([id, categoryId, name], i) => ({
  id: id!,
  name: name!,
  categoryId: categoryId!,
  createdAt: now0 - (50 - i) * 86400_000,
  resolved: id!,
}));
const ki = (
  n: number,
  topicId: string,
  title: string,
  daysAgo: number,
  refs: number[] = [],
  extra: Partial<KbItem> = {},
): KbItem => ({
  key: `mem-${n % 3 === 0 ? 'me' : n % 3 === 1 ? 'a' : 'd'}:k${n}`,
  author: n % 3 === 0 ? 'mem-me' : n % 3 === 1 ? 'mem-a' : 'mem-d',
  title,
  body: `${title}的重點整理。\n\n- 為什麼這樣做\n- 怎麼操作\n- 常見問題`,
  format: 'markdown',
  spec: null,
  tags: [],
  topicId,
  refs: refs.map((r) => `mem-${r % 3 === 0 ? 'me' : r % 3 === 1 ? 'a' : 'd'}:k${r}`),
  source: { kind: 'manual' },
  createdAt: now0 - daysAgo * 86400_000,
  updatedAt: now0 - daysAgo * 86400_000,
  updatedBy: 'mem-me',
  ...extra,
});
let kbItems: KbItem[] = [
  ki(1, 't-store', 'D39 儲存節點', 40),
  ki(2, 't-store', 'Reed-Solomon 8/5 分片', 38, [1]),
  ki(3, 't-store', '檔案續傳', 30, [1, 2]),
  ki(4, 't-sync', 'Automerge 文件切分', 35, [1]),
  ki(5, 't-sync', 'mailbox 補同步', 28, [4]),
  ki(6, 't-crypto', 'HPKE 金鑰封裝', 33, [4, 5]),
  ki(20, 't-store', '儲存節點維運手冊', 2, [1], {
    spec: 'hills-doc/1',
    body: [
      '## 摘要 {#summary}',
      '儲存節點用 **RS(8,5)** 分片，任 3 個節點故障仍可下載。',
      '',
      '> [!WARNING]',
      '> 同時下線超過 3 台會造成資料無法還原。',
      '',
      '## 內容 {#content}',
      '| 項目 | 數值 |',
      '|---|---|',
      '| 節點數 | 8 |',
      '| 容錯 | 3 |',
      '',
      '```bash',
      'docker compose up -d storage',
      '```',
      '',
      '## 重點 {#points}',
      '- [x] 每週檢查磁碟',
      '- [ ] 設定告警',
      '',
      '## 來源 {#sources}',
      '- technical-design §15',
    ].join('\n'),
  }),
  ki(21, 't-store', 'B / C 廠設備清單差異表', 1, [], {
    format: 'html',
    spec: 'hills-doc/1',
    source: { kind: 'task', teamId: 'default', taskId: 't1' },
    body: '<article data-hills-doc="1"><style>.hl{background:#fff4e5}</style><section data-section="summary"><h2>摘要</h2><p>共 31 項差異：型號不同 12、數量不同 7。</p></section><section data-section="content"><h2>內容</h2><table><thead><tr><th>設備</th><th>B 廠</th><th>C 廠</th></tr></thead><tbody><tr class="hl"><td>鼓風機 #2</td><td>RB-75</td><td>RB-90</td></tr><tr><td>加藥泵</td><td>DP-30</td><td>DP-30A</td></tr></tbody></table><p onclick="alert(1)">（點我不會執行）</p><script>alert(1)</script></section><section data-section="x-chart"><h2>自訂：分布</h2><p style="color:#1f6feb">型號 39% · 數量 23%</p></section></article>',
  }),
  ki(7, 't-relay', 'relay 部署', 20, [1, 5], {
    source: { kind: 'message', convId: 'g1', messageKey: 'mem-a:1' },
  }),
  ki(8, 't-relay', 'LetsEncrypt 憑證更新', 18, [7]),
  ki(9, 't-docker', 'compose 重置步驟', 12, [7], {
    source: { kind: 'message', convId: 'g1', messageKey: 'mem-b:2' },
  }),
  ki(10, 't-docker', '儲存節點 volume', 9, [1, 9]),
  ki(11, 't-onb', 'CAFECA 登入流程', 15, [6]),
  ki(12, 't-onb', '測試帳號', 3, [11]),
  ki(13, 't-goal', 'OKR 寫法', 25),
  ki(14, 't-goal', '週目標怎麼拆', 2, [13]),
  ki(15, 't-leave', '特休計算', 22),
  ki(16, 't-leave', '補打卡規則', 16, [15]),
  ki(17, 't-vis', '焦點山配色', 26),
  ki(18, 't-vis', '星空夜色', 1, [17]),
  ki(19, 't-vis', '狀態徽章', 14, [17]),
];
// 示範 Scrum（虛構）
const TODAY = periodsAt(Date.now(), 'Asia/Taipei').day;
let scrumReports: ScrumReport[] = [
  {
    member: 'mem-a',
    date: TODAY,
    done: [{ kind: 'text', title: '邀請碼流程' }],
    today: [
      { kind: 'text', title: '檢查 SAS' },
      { kind: 'text', title: '寫測試' },
    ],
    blockers: [{ text: '需要 relay 測試主機', notified: ['mem-me'] }],
    submittedAt: now0 - 3600_000,
    updatedAt: now0 - 3600_000,
  },
  {
    member: 'mem-d',
    date: TODAY,
    done: [{ kind: 'text', title: 'Mac 驗收' }],
    today: [{ kind: 'text', title: '通知測試' }],
    blockers: [],
    submittedAt: now0 - 7200_000,
    updatedAt: now0 - 7200_000,
  },
];
const scrumDrafts: Record<string, string> = {};
let scrumReminder = { org: '17:30', mine: null as string | null };
// 示範報表（虛構）
let reports: Report[] = [
  {
    member: 'mem-a',
    kind: 'weekly',
    period: periodsAt(Date.now(), 'Asia/Taipei').week,
    sections: {
      progress:
        '**完成**\n- 邀請碼流程\n\n**進行中**\n- SAS 驗證\n\n**阻礙**\n- 需要 relay 測試主機',
      okr: '- 招募兩位工程師 — 50%',
      attendance: '出勤資料將於假勤功能上線後自動帶入。',
      next: '- 檢查 relay',
    },
    publishedTo: ['default'],
    generatedAt: now0 - 7200_000,
    publishedAt: now0 - 3600_000,
    editedAt: null,
  },
];
const reportDrafts: Record<string, string> = {};
let manualFocus: string | null = null;
let myLook = look(0, 5, 2, 1);
let myProfile: MemberProfile = {
  displayName: '',
  timezone: '',
  workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  updatedAt: 0,
};
let notifyPrefs: NotifyPrefs = {
  messages: true,
  assigned: true,
  blockers: false,
  scrumReminder: true,
};
const syncStatus = (t: MockTask) => {
  if (t.steps.length && t.steps.every((x) => x.done)) t.status = 'done';
  else if (t.steps.some((x) => x.done)) t.status = t.status === 'review' ? 'review' : 'doing';
  else if (t.steps.length && t.status === 'done') t.status = 'todo';
  // 任務完成時間（technical-design §16.8 v0.21）
  if (t.status === 'done') t.doneAt = t.doneAt ?? Date.now();
  else t.doneAt = null;
};
const touch = (name = 'doc') => emit('hills://node', name);
let joins: JoinRequestView[] = [
  {
    device: 'ef'.repeat(32),
    kind: 'join',
    memberId: 'mem-new',
    name: '周小宇',
    deviceName: 'ThinkPad',
    handle: 'yu_chou',
    account: '0x' + '3f'.repeat(20),
    accountShort: '0x3f3f…3f3f',
    receivedAt: Date.now() - 20 * 60_000,
  },
];
/** 模擬中的 CAFECA 登入。 */
let onboard: { args: OnboardArgs; started: number } | null = null;
let devices: DeviceInfo[] = [
  { id: 'ab'.repeat(32), name: 'MacBook Pro', issuedAt: Date.now() - 86400_000, thisDevice: true },
  { id: 'cd'.repeat(32), name: 'Windows 筆電', issuedAt: Date.now() - 3600_000, thisDevice: false },
];

interface MockMsg {
  id: string;
  conv: string;
  author: string;
  createdAt: number;
  kind: string;
  body: string;
  mentions: string[];
  attachments: unknown;
  task?: { team: string; id: string } | null;
}
const convs = [
  {
    id: 'g1',
    kind: 'group',
    name: '產品討論',
    creator: 'mem-me',
    createdAt: Date.now() - 86400_000,
    members: ['mem-me', 'mem-a', 'mem-b'],
  },
  {
    id: 'd1',
    kind: 'dm',
    name: '',
    creator: 'mem-a',
    createdAt: Date.now() - 3600_000,
    members: ['mem-me', 'mem-a'],
  },
];
const msgs: MockMsg[] = [
  {
    id: '0',
    conv: 'g1',
    author: 'mem-me',
    createdAt: Date.now() - 2 * 3600_000,
    kind: 'text',
    body: '今天把 Windows 驗收收尾',
    mentions: [],
    attachments: null,
  },
  {
    id: '0b',
    conv: 'g1',
    author: 'mem-me',
    createdAt: Date.now() - 2 * 3600_000 + 1000,
    kind: 'task',
    body: '',
    mentions: [],
    attachments: null,
    task: { team: 'default', id: 't1' },
  },
  {
    id: '1',
    conv: 'g1',
    author: 'mem-a',
    createdAt: Date.now() - 600_000,
    kind: 'text',
    body: '邀請碼流程完成了，**請幫忙看**',
    mentions: [],
    attachments: null,
  },
  {
    id: '2',
    conv: 'g1',
    author: 'mem-b',
    createdAt: Date.now() - 300_000,
    kind: 'text',
    body: '@我 下午看\n\n- 檢查 SAS\n- 檢查 `relay`',
    mentions: ['mem-me'],
    attachments: null,
  },
  {
    id: '3',
    conv: 'd1',
    author: 'mem-a',
    createdAt: Date.now() - 120_000,
    kind: 'text',
    body: '晚點聊？',
    mentions: [],
    attachments: null,
  },
];
const read: Record<string, number> = {};

const delay = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  app_info: (): AppInfo => ({
    phase: state.phase,
    memberId: state.phase === 'welcome' ? null : state.me,
    orgName: state.phase === 'welcome' ? null : state.orgName,
    isAdmin: state.isAdmin,
    sync: state.phase === 'welcome' ? null : state.phase === 'pending' ? 'Pending' : 'Synced',
    hasOrgRoot: state.isAdmin,
    devLogin: true,
  }),
  reset_local_data: () => {
    state.phase = 'welcome';
  },
  onboard_begin: (a) => {
    onboard = { args: a.args as OnboardArgs, started: Date.now() };
    if (onboard.args.devAccount) {
      onboard.started -= 4000;
      return { qrSvg: '', code: 'K7QD-M2XA', expiresAt: Math.floor(Date.now() / 1000) + 600 };
    }
    return {
      ...code('https://wallet.example/dl/auth?v=1&req=...'),
      code: 'K7QD-M2XA',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    };
  },
  onboard_open_link: () => undefined,
  onboard_cancel: () => {
    onboard = null;
  },
  onboard_poll: (): OnboardStatus => {
    if (!onboard) throw new Error('沒有進行中的登入');
    const elapsed = Date.now() - onboard.started;
    const mode = params.get('signin');
    if (elapsed < 4000) return { step: 'signin', handle: null };
    if (mode === 'denied') return { step: 'denied', handle: null };
    const kind = onboard.args.kind;
    if (kind === 'create') {
      state.orgName = onboard.args.orgName ?? state.orgName;
      state.phase = 'ready';
      onboard = null;
      return { step: 'created', handle: 'me' };
    }
    if (kind === 'join' && mode === 'device') {
      if (elapsed < 9000) return { step: 'device', handle: 'me' };
      state.phase = 'ready';
      onboard = null;
      return { step: 'linked', handle: 'me' };
    }
    state.phase = 'pending';
    state.isAdmin = false;
    onboard = null;
    setTimeout(() => {
      state.phase = 'ready';
      emit('hills://node', 'activated');
    }, 4000);
    return { step: 'approval', handle: 'me' };
  },
  export_org_root_backup: () => '~/Downloads/hills-org-root.hillsbackup',
  link_start: () => {
    setTimeout(() => emit('hills://link-sas', '284913'), 1500);
    return code('hills-link1-' + 'x'.repeat(80));
  },
  link_cancel: () => undefined,
  link_device: () => '284913',
  link_confirm: () => undefined,
  overview: (): Overview => ({
    orgName: state.orgName,
    members: [
      {
        id: state.me,
        name: myProfile.displayName || '我',
        rosterName: '我',
        isAdmin: state.isAdmin,
        isMe: true,
        joinedAt: 0,
        presence: state.presence,
        note: state.note,
        until: state.until,
        location: state.location,
        look: myLook,
      },
      ...others,
    ],
    teams: mockTeams
      .filter((t) => !t.archived)
      .map((t) => ({ id: t.id, name: t.name, members: t.members, leads: t.leads })),
    offices,
    lunchBreak,
    timezone: 'Asia/Taipei',
  }),
  kb: () => ({ categories: kbCats, topics: kbTopics, items: kbItems }),
  kb_save: (a) => {
    const input = a.input as KbInput;
    const key = input.key || `${state.me}:k${Date.now()}`;
    const old = kbItems.find((x) => x.key === key);
    const item: KbItem = {
      key,
      author: old?.author ?? state.me,
      title: input.title,
      body: input.body,
      format: input.format ?? 'markdown',
      spec: input.spec ?? null,
      tags: input.tags,
      topicId: input.topicId,
      refs: input.refs,
      source: old?.source ?? input.source ?? { kind: 'manual' },
      createdAt: old?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      updatedBy: state.me,
    };
    kbItems = [...kbItems.filter((x) => x.key !== key), item];
    touch();
    return key;
  },
  kb_delete: (a) => {
    kbItems = kbItems.filter((x) => x.key !== a.key);
    touch();
  },
  kb_create_category: (a) => {
    const id = 'c' + Date.now();
    kbCats.push({ id, name: String(a.name), createdAt: Date.now(), resolved: id });
    touch();
    return id;
  },
  kb_create_topic: (a) => {
    const id = 't' + Date.now();
    kbTopics.push({
      id,
      name: String(a.name),
      categoryId: String(a.category),
      createdAt: Date.now(),
      resolved: id,
    });
    touch();
    return id;
  },
  kb_rename: (a) => {
    const list: { id: string; name: string }[] = a.kind === 'category' ? kbCats : kbTopics;
    const x = list.find((y) => y.id === a.id);
    if (x) x.name = String(a.name);
    touch();
  },
  kb_merge: (a) => {
    if (a.kind === 'category') {
      const x = kbCats.find((y) => y.id === a.from);
      if (x) x.resolved = String(a.into);
      kbTopics.forEach((tp) => {
        if (tp.categoryId === a.from) tp.categoryId = String(a.into);
      });
    } else {
      const x = kbTopics.find((y) => y.id === a.from);
      if (x) x.resolved = String(a.into);
    }
    touch();
  },
  kb_from_message: (a) => {
    const m = msgs.find((x) => `${x.author}:${x.id}` === a.messageKey);
    if (!m) throw new Error('找不到訊息');
    const key = `${state.me}:k${Date.now()}`;
    kbItems.push({
      key,
      author: state.me,
      title: String(a.title),
      body: m.body,
      format: 'markdown',
      spec: null,
      tags: [],
      topicId: String(a.topic),
      refs: [],
      source:
        a.attachment === null || a.attachment === undefined
          ? { kind: 'message', convId: m.conv, messageKey: String(a.messageKey) }
          : { kind: 'file', convId: m.conv, attachment: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: state.me,
    });
    touch();
    return key;
  },
  scrum_mine: (a) => ({
    report: scrumReports.find((r) => r.member === state.me && r.date === a.date) ?? null,
    draft: scrumDrafts[String(a.date)] ?? null,
    notify: ['mem-me'].filter((x) => x !== state.me).concat(state.isAdmin ? [] : ['mem-me']),
  }),
  scrum_submit: (a) => {
    const input = a.input as ScrumInput;
    const old = scrumReports.find((r) => r.member === state.me && r.date === input.date);
    const r: ScrumReport = {
      member: state.me,
      date: input.date,
      done: input.done,
      today: input.today,
      blockers: input.blockers.map((text) => ({ text, notified: [] })),
      submittedAt: old?.submittedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    scrumReports = [...scrumReports.filter((x) => x !== old), r];
    delete scrumDrafts[input.date];
    touch();
    return r;
  },
  scrum_team: (a) => scrumReports.filter((r) => r.date >= String(a.from) && r.date <= String(a.to)),
  scrum_draft_set: (a) => {
    if (a.draft === null) delete scrumDrafts[String(a.date)];
    else scrumDrafts[String(a.date)] = String(a.draft);
  },
  scrum_reminder: () => scrumReminder,
  set_my_scrum_reminder: (a) => {
    scrumReminder = { ...scrumReminder, mine: (a.hhmm as string | null) ?? null };
  },
  set_org_scrum_reminder: (a) => {
    scrumReminder = { ...scrumReminder, org: String(a.hhmm) };
    touch('org');
  },
  scrum_remind: () => false,
  report_mine: (a) => ({
    report:
      reports.find((r) => r.member === state.me && r.kind === a.kind && r.period === a.period) ??
      null,
    draft: reportDrafts[`${String(a.kind)}:${String(a.period)}`] ?? null,
  }),
  report_publish: (a) => {
    const input = a.input as ReportInput;
    const old = reports.find(
      (r) => r.member === state.me && r.kind === input.kind && r.period === input.period,
    );
    const r: Report = {
      member: state.me,
      kind: input.kind,
      period: input.period,
      sections: input.sections,
      publishedTo: input.publishedTo,
      generatedAt: input.generatedAt ?? Date.now(),
      publishedAt: Date.now(),
      editedAt: old ? Date.now() : null,
    };
    reports = [...reports.filter((x) => x !== old), r];
    delete reportDrafts[`${input.kind}:${input.period}`];
    touch();
    return r;
  },
  report_team: (a) => reports.filter((r) => r.kind === a.kind && r.period === a.period),
  report_draft_set: (a) => {
    const k = `${String(a.kind)}:${String(a.period)}`;
    if (a.draft === null) delete reportDrafts[k];
    else reportDrafts[k] = String(a.draft);
  },
  report_remind: () => false,
  export_text: () => true,
  plans: (a) => withTaskProgress(a.mineOnly ? plans.filter((x) => x.mine) : plans),
  save_plan: (a) => {
    const input = a.input as PlanInput;
    const id = input.id || 'p' + Math.random().toString(16).slice(2, 8);
    const old = plans.find((x) => x.id === id);
    const item: PlanView = {
      ...input,
      id,
      owner: state.me,
      keyResults: input.keyResults.map((k, i) => ({ ...k, id: k.id || `${id}-k${i}` })),
      alignedGoalId: input.alignedGoalId ?? null,
      criteria: (input.criteria ?? []).map((c, i) => ({ ...c, id: c.id || `${id}-c${i}` })),
      helps: input.helps ?? [],
      createdAt: old?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      progress: input.progressOverride ?? (input.done ? 100 : (old?.progress ?? 0)),
      krProgress: old?.krProgress ?? {},
      mine: true,
    };
    plans = [...plans.filter((x) => x.id !== id), item];
    touch();
    return id;
  },
  directions: () => directionsView(),
  direction_summaries: () => summaries,
  my_suggestions: () => suggestionsToMe,
  publish_direction: (a) => {
    const week = a.week as DirectionWeek;
    const old = summaries.find((m) => m.member === state.me)?.weeks ?? [];
    summaries = [
      ...summaries.filter((m) => m.member !== state.me),
      {
        member: state.me,
        weeks: [{ ...week, updatedAt: Date.now() }, ...old.filter((w) => w.week !== week.week)]
          .sort((x, y) => y.week.localeCompare(x.week))
          .slice(0, 8),
      },
    ];
    touch();
  },
  suggest_align: (a) => {
    if (a.to === state.me) throw new Error('不能建議自己');
    touch();
  },
  week_notes: () => weekNotes,
  // 本機 MCP（D48）：示範一筆待確認變更
  mcp_settings: () => ({
    allowed: mcp.allowed,
    isAdmin: true,
    enabled: mcp.enabled,
    running: mcp.allowed && mcp.enabled,
    port: 47321,
    endpoint: 'http://127.0.0.1:47321/mcp',
    token: mcp.allowed && mcp.enabled ? mcp.token : null,
    error: null,
  }),
  set_mcp_enabled: (a) => {
    mcp.enabled = Boolean(a.enabled);
    emit('hills://mcp', 'settings');
  },
  regenerate_mcp_token: () => {
    mcp.token = 'DEMO' + Math.random().toString(36).slice(2, 14).toUpperCase();
    emit('hills://mcp', 'settings');
    return mcp.token;
  },
  set_mcp_allowed: (a) => {
    mcp.allowed = Boolean(a.allowed);
    emit('hills://mcp', 'settings');
  },
  mcp_pending: () => mcp.pending,
  mcp_approve: (a) => {
    const c = mcp.pending.find((x) => x.id === a.id);
    if (!c) throw new Error('這個變更已處理或已過期');
    mcp.pending = mcp.pending.filter((x) => x.id !== a.id);
    mcp.audit.unshift({ at: Date.now(), client: c.client, tool: c.tool, outcome: 'approved' });
    if (c.preview.action === 'createTask') {
      tasks = [
        ...tasks,
        {
          id: 't-mcp-' + Date.now(),
          team: c.preview.team ?? 'default',
          title: c.preview.title ?? '',
          assignee: c.preview.assignee ?? state.me,
          status: 'todo',
          dueAt: c.preview.dueAt ?? null,
          steps: [],
          planItemId: null,
          createdBy: state.me,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      touch();
    }
    emit('hills://mcp', 'resolved');
    return 'ok';
  },
  mcp_reject: (a) => {
    const c = mcp.pending.find((x) => x.id === a.id);
    mcp.pending = mcp.pending.filter((x) => x.id !== a.id);
    if (c)
      mcp.audit.unshift({ at: Date.now(), client: c.client, tool: c.tool, outcome: 'rejected' });
    emit('hills://mcp', 'resolved');
  },
  mcp_audit: () => mcp.audit.slice(0, 20),
  set_week_note: (a) => {
    const team = a.team as string;
    const week = a.week as string;
    const text = (a.text as string).trim();
    weekNotes = weekNotes.filter((n) => !(n.team === team && n.week === week));
    if (text) weekNotes.push({ team, week, text, author: state.me, updatedAt: Date.now() });
    touch();
  },
  direction_rules: () => driftRules,
  set_direction_rules: (a) => {
    driftRules = a.rules as DirectionRules;
    touch('org');
  },
  save_direction: (a) => {
    const input = a.input as DirectionInput;
    const id = input.id || 'dir-' + Math.random().toString(16).slice(2, 8);
    const old = directions.find((d) => d.id === id);
    directions = [
      ...directions.filter((d) => d.id !== id),
      {
        ...dirRec(id, input.year, input.title),
        keyResults: input.keyResults,
        createdAt: old?.createdAt ?? Date.now(),
      },
    ];
    touch();
    return id;
  },
  delete_direction: (a) => {
    directions = directions.filter((d) => d.id !== a.id);
    touch();
  },
  save_team_goal: (a) => {
    const input = a.input as TeamGoalInput;
    const id = input.id || 'tg-' + Math.random().toString(16).slice(2, 8);
    const old = teamGoals.find((g) => g.id === id);
    teamGoals = [
      ...teamGoals.filter((g) => g.id !== id),
      {
        ...dirRec(id, input.year, input.title),
        team: input.team,
        directionId: input.directionId,
        keyResults: input.keyResults,
        criteria: input.criteria.map((c, i) => ({ ...c, id: c.id || `${id}-c${i}` })),
        createdAt: old?.createdAt ?? Date.now(),
      },
    ];
    touch();
    return id;
  },
  delete_team_goal: (a) => {
    teamGoals = teamGoals.filter((g) => g.id !== a.id);
    touch();
  },
  set_plan_done: (a) => {
    plans = plans.map((x) =>
      x.id === a.id ? { ...x, done: Boolean(a.done), progress: a.done ? 100 : 0 } : x,
    );
    touch();
  },
  delete_plan: (a) => {
    plans = plans.filter((x) => x.id !== a.id);
    touch();
  },
  set_presence: (a) => {
    state.presence = a.presence as PresenceState;
    state.note = String(a.note);
    if (typeof a.location === 'string') {
      state.location = a.location;
      state.until = (a.until as number | null) ?? null;
    }
    touch('presence');
  },
  tasks: () => tasks.map(withAck),
  set_task_ack: (a) => {
    tasks = tasks.map((x) =>
      x.id === a.task
        ? {
            ...x,
            ack: {
              state: a.ack as 'accepted' | 'concern',
              note: a.note ? String(a.note) : undefined,
              at: Date.now(),
            },
          }
        : x,
    );
    touch();
  },
  create_task: (a) => {
    const input = a.input as Omit<MockTask, 'id' | 'team' | 'steps'> & { steps: MockStep[] };
    const id = 't' + (tasks.length + 1) + Math.random().toString(16).slice(2, 6);
    tasks = [
      ...tasks,
      {
        ...input,
        id,
        team: String(a.team),
        status: 'todo',
        assignee: a.team === 'private' ? state.me : input.assignee,
        planItemId: input.planItemId ?? null,
        steps: input.steps.map((x, i) => ({ ...x, id: x.id ?? `${id}-${i}`, doneAt: null })),
        assignedBy: input.assignee ? state.me : null,
        assignedAt: input.assignee ? Date.now() : null,
        teamGoalId: input.teamGoalId ?? null,
        brief: input.brief || null,
        acceptance: (input.acceptance ?? []).map((c, i) => ({
          id: c.id || `${id}-c${i}`,
          text: c.text,
        })),
        createdBy: state.me,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    touch();
    return id;
  },
  update_task: (a) => {
    const input = a.input as MockTask;
    tasks = tasks.map((x) =>
      x.id === a.task
        ? {
            ...x,
            ...input,
            brief:
              input.brief === undefined || input.brief === null ? x.brief : input.brief || null,
            acceptance: input.acceptance
              ? input.acceptance.map((c, i) => ({ id: c.id || `${x.id}-c${i}`, text: c.text }))
              : x.acceptance,
            status: input.status ?? x.status,
            doneAt: x.doneAt ?? null,
            planItemId: input.planItemId ?? null,
            ...(input.assignee !== x.assignee
              ? {
                  assignedBy: input.assignee ? state.me : null,
                  assignedAt: input.assignee ? Date.now() : null,
                  ack: null,
                }
              : {}),
            steps: input.steps.map((y, i) => ({
              ...y,
              id: y.id ?? `${x.id}-n${i}`,
              doneAt: y.done ? (x.steps.find((o) => o.id === y.id)?.doneAt ?? Date.now()) : null,
            })),
          }
        : x,
    );
    tasks.forEach(syncStatus);
    touch();
  },
  set_step_done: (a) => {
    const task = tasks.find((x) => x.id === a.task);
    const stp = task?.steps.find((x) => x.id === a.step);
    if (task && stp) {
      stp.done = Boolean(a.done);
      stp.doneAt = stp.done ? Date.now() : null;
      syncStatus(task);
    }
    touch();
  },
  task_logs: (a) =>
    taskLogs
      .filter((l) => l.task === a.task)
      .map((l) => {
        const { task, ...rest } = l;
        void task;
        return rest;
      }),
  add_task_log: (a) => {
    taskLogs.push({
      task: String(a.task),
      id: String(Date.now()),
      author: state.me,
      kind: a.kind as LogKind,
      text: String(a.text ?? ''),
      percent: (a.percent as number | null) ?? null,
      refs: [],
      at: Date.now(),
    });
    touch();
  },
  close_task: (a) => {
    const task = tasks.find((x) => x.id === a.task);
    if (!task) throw new Error('找不到任務');
    const input = a.input as CloseInput;
    if (!/\{#summary\}|data-section="summary"/.test(input.body))
      throw new Error('缺少段落：summary');
    taskReports.set(task.id, {
      v: 1,
      spec: 'hills-doc/1',
      ...input,
      at: Date.now(),
      author: state.me,
    });
    task.status = 'done';
    task.doneAt = Date.now();
    taskLogs.push({
      task: task.id,
      id: String(Date.now()),
      author: state.me,
      kind: 'close',
      text: '',
      percent: null,
      refs: [],
      at: Date.now(),
    });
    touch();
  },
  reopen_task: (a) => {
    const task = tasks.find((x) => x.id === a.task);
    if (!task) throw new Error('找不到任務');
    if (!String(a.text ?? '').trim()) throw new Error('請輸入內容');
    task.status = 'doing';
    task.doneAt = null;
    taskLogs.push({
      task: task.id,
      id: String(Date.now()),
      author: state.me,
      kind: 'reopen',
      text: String(a.text),
      percent: null,
      refs: [],
      at: Date.now(),
    });
    touch();
  },
  task_report: (a) => taskReports.get(String(a.task)) ?? null,
  delete_task: (a) => {
    tasks = tasks.filter((x) => x.id !== a.task);
    touch();
  },
  focus: () => {
    const open = tasks.filter(
      (x) =>
        x.status !== 'done' &&
        (x.assignee === state.me || x.steps.find((y) => !y.done)?.assignee === state.me),
    );
    const manual = open.find((x) => x.id === manualFocus);
    if (manual) return { task: withAck(manual), manual: true };
    const pick = [...open].sort((p, q) => (p.dueAt ?? Infinity) - (q.dueAt ?? Infinity))[0];
    return { task: pick ? withAck(pick) : null, manual: false };
  },
  set_focus: (a) => {
    manualFocus = (a.task as string | null) ?? null;
    touch();
  },
  set_profile: (a) => {
    myLook = a.look as typeof myLook;
    touch();
  },
  my_profile: () => myProfile,
  set_my_profile: (a) => {
    myProfile = { ...(a.profile as MemberProfile), updatedAt: Date.now() };
    touch();
  },
  member_profiles: () => [
    { member: state.me, ...myProfile },
    {
      member: 'mem-d',
      displayName: '',
      timezone: 'Asia/Taipei',
      workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
      updatedAt: 0,
    },
    {
      member: 'mem-e',
      displayName: '',
      timezone: 'America/Los_Angeles',
      workHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      updatedAt: 0,
    },
  ],
  notify_prefs: () => notifyPrefs,
  set_notify_prefs: (a) => {
    notifyPrefs = a.prefs as NotifyPrefs;
    touch();
  },
  upsert_office: (a) => {
    const id = (a.id as string | null) ?? 'o' + Math.random().toString(16).slice(2, 8);
    offices = offices.some((o) => o.id === id)
      ? offices.map((o) => (o.id === id ? { ...o, name: String(a.name) } : o))
      : [...offices, { id, name: String(a.name) }];
    touch('org');
    return id;
  },
  remove_office: (a) => {
    offices = offices.filter((o) => o.id !== a.id);
    touch('org');
  },
  set_lunch_break: (a) => {
    lunchBreak = a.start ? { start: String(a.start), end: String(a.end) } : null;
    touch('org');
  },
  app_version: () => ({ version: '0.1.0', commit: 'mock' }),
  sync_status: () => (state.phase === 'pending' ? 'Pending' : 'Synced'),
  sync_now: () => undefined,
  org_code: () => code('hills-org1-' + 'y'.repeat(90)),
  cafeca_account: () => ({
    address: '0x' + 'a1'.repeat(20),
    short: '0xa1a1…a1a1',
    handle: 'demo_me',
  }),
  pending_joins: () => joins,
  approve_join: (a) => {
    joins = joins.filter((j) => j.device !== a.device);
    touch('joins');
  },
  teams_info: () => mockTeams,
  create_team: (a) => {
    const name = String(a.name).trim();
    const members = a.members as string[];
    if (!name) throw new Error('小組名稱需為 1–40 字');
    if (members.length === 0) throw new Error('小組至少要有一位成員');
    const id = 't' + Date.now();
    mockTeams = [
      ...mockTeams,
      {
        id,
        name,
        members,
        leads: a.leads as string[],
        archived: false,
        awaitingKey: false,
        canManage: true,
      },
    ];
    touch('org');
    return id;
  },
  rename_team: (a) => {
    mockTeams = mockTeams.map((t) => (t.id === a.id ? { ...t, name: String(a.name) } : t));
    touch('org');
  },
  archive_team: (a) => {
    mockTeams = mockTeams.map((t) => (t.id === a.id ? { ...t, archived: Boolean(a.archived) } : t));
    touch('org');
  },
  set_team_members: (a) => {
    const members = a.members as string[];
    if (members.length === 0) throw new Error('小組至少要有一位成員');
    mockTeams = mockTeams.map((t) =>
      t.id === a.id ? { ...t, members, leads: a.leads as string[] } : t,
    );
    touch('org');
  },
  reject_join: (a) => {
    joins = joins.filter((j) => j.device !== a.device);
    touch('joins');
  },
  conversations: () =>
    convs.map((c) => {
      const all = msgs.filter((m) => m.conv === c.id);
      const list = all.filter((m) => m.kind !== 'task');
      const last = list[list.length - 1] ?? null;
      const unread = list.filter(
        (m) => m.author !== state.me && m.createdAt > (read[c.id] ?? 0),
      ).length;
      const link = [...all].reverse().find((m) => m.kind === 'task');
      return { ...c, last, unread, task: link?.task ?? null };
    }),
  messages: (a) => msgs.filter((m) => m.conv === a.conv),
  open_dm: (a) => {
    const found = convs.find((c) => c.kind === 'dm' && c.members.includes(String(a.member)));
    if (found) return found.id;
    const id = 'd' + (convs.length + 1);
    convs.push({
      id,
      kind: 'dm',
      name: '',
      creator: state.me,
      createdAt: Date.now(),
      members: [state.me, String(a.member)],
    });
    return id;
  },
  create_group: (a) => {
    const id = 'g' + (convs.length + 1);
    convs.push({
      id,
      kind: 'group',
      name: String(a.name),
      creator: state.me,
      createdAt: Date.now(),
      members: [state.me, ...(a.members as string[])],
    });
    emit('hills://node', 'convs');
    return id;
  },
  set_conv_task: (a) => {
    const team = a.team as string | null;
    const id = a.task as string | null;
    if (team && id && !tasks.some((x) => x.team === team && x.id === id)) {
      throw new Error('找不到這個任務');
    }
    msgs.push({
      id: String(msgs.length + 1),
      conv: String(a.conv),
      author: state.me,
      createdAt: Date.now(),
      kind: 'task',
      body: '',
      mentions: [],
      attachments: null,
      task: team && id ? { team, id } : null,
    });
    emit('hills://node', 'message');
  },
  send_message: (a) => {
    const m: MockMsg = {
      id: String(msgs.length + 1),
      conv: String(a.conv),
      author: state.me,
      createdAt: Date.now(),
      kind: a.attachments ? 'files' : 'text',
      body: String(a.body),
      mentions: a.mentions as string[],
      attachments: a.attachments ?? null,
    };
    msgs.push(m);
    emit('hills://node', 'message');
    return m;
  },
  add_conv_members: (a) => {
    const c = convs.find((x) => x.id === a.conv);
    c?.members.push(...(a.members as string[]));
    emit('hills://node', 'convs');
  },
  remove_conv_member: (a) => {
    const c = convs.find((x) => x.id === a.conv);
    if (c) c.members = c.members.filter((m) => m !== a.member);
    emit('hills://node', 'convs');
  },
  rename_conv: () => undefined,
  set_active_conv: (a) => {
    if (a.conv && typeof a.readUntil === 'number') {
      read[String(a.conv)] = a.readUntil;
      emit('hills://node', 'convs');
    }
  },
  rename_org: (a) => {
    state.orgName = String(a.name);
    emit('hills://node', 'org');
  },
  revoke_member: (a) => {
    const i = others.findIndex((m) => m.id === a.memberId);
    if (i >= 0) others.splice(i, 1);
    emit('hills://node', 'roster');
  },
  devices: () => devices,
  revoke_device: (a) => {
    devices = devices.filter((d) => d.id !== a.deviceId);
  },
};

// ── 檔案分享：假的檔案、8 個記憶體儲存節點（加密與 RS 編碼仍在前端真實執行） ──
const MB = 1024 * 1024;
const fakeFiles = new Map<string, { name: string; size: number; seed: number }>();
let fileSeq = 0;
const addFake = (name: string, size: number) => {
  const token = `f${++fileSeq}`;
  fakeFiles.set(token, { name, size, seed: fileSeq });
  return { token, name, size, mtime: Date.now() - 86400_000 };
};
const shards = new Map<string, Uint8Array>();
const writes = new Map<string, number>();
const fileHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  pick_files: () => [addFake('季度報告.pdf', 3 * MB + 12345), addFake('會議紀錄.md', 2048)],
  pick_folder: () => {
    const a = addFake('hero@2x.png', 2 * MB);
    const b = addFake('logo.svg', 40_000);
    const c = addFake('說明.txt', 1200);
    return {
      root: '設計稿',
      entries: [
        { kind: 'dir', path: '首頁' },
        { kind: 'file', path: '首頁/hero@2x.png', token: a.token, size: a.size, mtime: null },
        { kind: 'file', path: '首頁/logo.svg', token: b.token, size: b.size, mtime: null },
        { kind: 'file', path: '說明.txt', token: c.token, size: c.size, mtime: null },
      ],
      skipped: [{ path: '.DS_Store', reason: 'system' }],
      totalSize: a.size + b.size + c.size,
      fileCount: 3,
    };
  },
  read_stripe: (a) => {
    const f = fakeFiles.get(String(a.token));
    if (!f) throw new Error('檔案未經選擇');
    const off = Number(a.offset);
    const len = Math.max(0, Math.min(Number(a.len), f.size - off));
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = (off + i + f.seed * 7) & 0xff;
    return out;
  },
  storage_nodes: () => [0, 1, 2, 3, 4, 5, 6, 7],
  has_shards: (a) => (a.ids as string[]).map((id) => shards.has(`${String(a.node)}/${id}`)),
  get_shard: (a) => {
    const d = shards.get(`${String(a.node)}/${String(a.id)}`);
    if (!d) throw new Error('NotFound');
    return d;
  },
  save_target_file: () => 'dl-file',
  save_target_folder: () => ({ token: 'dl-dir', name: 'Downloads' }),
  finish_download: (a) => {
    const key = `${String(a.token)}/${String(a.path)}`;
    writes.delete(key);
    return String(a.path).split('/').pop() || '季度報告.pdf';
  },
  abort_download: () => undefined,
  show_download: () => undefined,
  save_upload_jobs: () => undefined,
  upload_jobs: () => [],
};
Object.assign(handlers, fileHandlers);

export const mockBackend = {
  invoke: async <T>(
    cmd: string,
    args: Record<string, unknown> | Uint8Array = {},
    options?: { headers: Record<string, string> },
  ): Promise<T> => {
    await delay(
      cmd.endsWith('_shard') || cmd === 'read_stripe' || cmd === 'write_partial' ? 5 : 200,
    );
    // 啟動畫面截圖用：?bootDelay=毫秒 讓 app_info 晚一點回來
    if (cmd === 'app_info') {
      const extra = Number(new URLSearchParams(window.location.search).get('bootDelay') ?? 0);
      if (extra > 0) await delay(extra);
    }
    // 載入骨架截圖用：?loadDelay=毫秒 讓資料讀取晚一點回來
    if (cmd !== 'app_info') {
      const extra = Number(new URLSearchParams(window.location.search).get('loadDelay') ?? 0);
      if (extra > 0) await delay(extra);
    }
    if (args instanceof Uint8Array) {
      const h = options?.headers ?? {};
      if (cmd === 'put_shard') shards.set(`${h['x-node']}/${h['x-id']}`, args.slice());
      if (cmd === 'write_partial') {
        const key = `${h['x-token']}/${decodeURIComponent(h['x-path'] ?? '')}`;
        writes.set(key, (writes.get(key) ?? 0) + args.length);
      }
      return undefined as T;
    }
    const h = handlers[cmd];
    if (!h) throw new Error(`mock: unknown command ${cmd}`);
    return h(args) as T;
  },
  listen: async <T>(event: string, cb: (payload: T) => void) => {
    const set = listeners.get(event) ?? new Set<Handler>();
    set.add(cb as Handler);
    listeners.set(event, set);
    return () => set.delete(cb as Handler);
  },
};
