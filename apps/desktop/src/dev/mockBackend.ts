/**
 * 開發用假後端：在瀏覽器（非 Tauri）預覽畫面時使用，只在 dev build 載入。
 * 資料皆為虛構示範內容。CAFECA 登入以計時模擬（`?signin=device` 模擬新增裝置、`?signin=denied` 模擬拒絕）。
 */
import type {
  AppInfo,
  Code,
  DeviceInfo,
  JoinRequestView,
  MemberView,
  OnboardArgs,
  OnboardStatus,
  Overview,
  PresenceState,
} from '../api';

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
const look = (hair: number, shirt: number, skin: number) => ({ hair, shirt, skin });
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
  person('mem-a', '王小明', 'Online', 'office:tpe', look(0, 0, 0)),
  person('mem-b', '陳小華', 'Meeting', 'office:tpe', look(1, 1, 1), now0 + 50 * 60_000, '週會'),
  person('mem-c', '周子安', 'Lunch', 'office:tpe', look(2, 2, 2), now0 + 50 * 60_000),
  person('mem-d', '林小美', 'Online', 'office:hsz', look(3, 3, 0), null, 'Windows 驗收'),
  person('mem-e', '黃宜靜', 'Away', 'office:hsz', look(1, 4, 3), now0 + 15 * 60_000),
  person('mem-f', '張大同', null, 'hidden', look(1, 7, 1)),
  person('mem-g', '李雅婷', 'Leave', 'office:tpe', look(2, 6, 0), now0 + 4 * 86400_000),
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
  steps: MockStep[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
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
    createdBy: 'mem-me',
    createdAt: now0 - 86400_000,
    updatedAt: now0,
  },
];
let manualFocus: string | null = null;
let myLook = look(0, 5, 2);
const syncStatus = (t: MockTask) => {
  if (t.steps.length && t.steps.every((x) => x.done)) t.status = 'done';
  else if (t.steps.some((x) => x.done)) t.status = 'doing';
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
        name: '我',
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
    teams: [{ id: 'default', name: '全體成員', members: [state.me, ...others.map((m) => m.id)] }],
    offices,
    lunchBreak,
  }),
  set_presence: (a) => {
    state.presence = a.presence as PresenceState;
    state.note = String(a.note);
    if (typeof a.location === 'string') {
      state.location = a.location;
      state.until = (a.until as number | null) ?? null;
    }
    touch('presence');
  },
  tasks: () => tasks,
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
        steps: input.steps.map((x, i) => ({ ...x, id: x.id ?? `${id}-${i}`, doneAt: null })),
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
            status: x.status,
            steps: input.steps.map((y, i) => ({ ...y, id: y.id ?? `${x.id}-n${i}`, doneAt: null })),
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
    if (manual) return { task: manual, manual: true };
    const pick = [...open].sort((p, q) => (p.dueAt ?? Infinity) - (q.dueAt ?? Infinity))[0];
    return { task: pick ?? null, manual: false };
  },
  set_focus: (a) => {
    manualFocus = (a.task as string | null) ?? null;
    touch();
  },
  set_profile: (a) => {
    myLook = a.look as typeof myLook;
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
  reject_join: (a) => {
    joins = joins.filter((j) => j.device !== a.device);
    touch('joins');
  },
  conversations: () =>
    convs.map((c) => {
      const list = msgs.filter((m) => m.conv === c.id);
      const last = list[list.length - 1] ?? null;
      const unread = list.filter(
        (m) => m.author !== state.me && m.createdAt > (read[c.id] ?? 0),
      ).length;
      return { ...c, last, unread };
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
