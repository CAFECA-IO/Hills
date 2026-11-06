/**
 * 開發用假後端：在瀏覽器（非 Tauri）預覽畫面時使用，只在 dev build 載入。
 * 資料皆為虛構示範內容，復原詞不是有效的金鑰。
 */
import type {
  AppInfo,
  Code,
  CreateOrgArgs,
  DeviceInfo,
  InviteView,
  MemberView,
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

const SAMPLE_WORDS_EN =
  'river cloud stone maple orbit candle meadow silver harbor puzzle lantern velvet ' +
  'thunder copper garden pepper rocket saddle timber walnut yellow zebra anchor basket';
const SAMPLE_WORDS_ZH = '山 丘 河 雲 石 楓 星 燈 草 銀 港 謎 光 絨 雷 銅 園 椒 箭 鞍 木 核 黃 斑';

const params = new URLSearchParams(window.location.search);
const state = {
  phase: (params.get('phase') as AppInfo['phase']) ?? 'welcome',
  orgName: '示範組織',
  isAdmin: true,
  me: 'mem-me',
  note: '',
  presence: 'Online' as PresenceState,
};

const others: MemberView[] = [
  {
    id: 'mem-a',
    name: '王小明',
    isAdmin: false,
    isMe: false,
    joinedAt: 0,
    presence: 'Online',
    note: '整理 M0 驗收清單',
  },
  {
    id: 'mem-b',
    name: '陳小華',
    isAdmin: false,
    isMe: false,
    joinedAt: 0,
    presence: 'Meeting',
    note: '週會',
  },
  {
    id: 'mem-c',
    name: '林小美',
    isAdmin: false,
    isMe: false,
    joinedAt: 0,
    presence: null,
    note: '',
  },
];
let invites: InviteView[] = [
  { id: 'a1b2c3d4', admin: false, expiresAt: Date.now() + 70 * 3600_000, mine: true },
];
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
  attachments: null;
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
  }),
  create_org: (a) => {
    state.orgName = (a.args as CreateOrgArgs).orgName;
    state.phase = 'ready';
  },
  join_org: () => {
    state.phase = 'pending';
    state.isAdmin = false;
    setTimeout(() => {
      state.phase = 'ready';
      emit('hills://node', 'activated');
    }, 4000);
  },
  recover: () => {
    state.phase = 'ready';
  },
  recovery_words: (a) =>
    (String(a.locale).startsWith('en') ? SAMPLE_WORDS_EN : SAMPLE_WORDS_ZH).split(' '),
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
      },
      ...others,
    ],
    teams: [{ id: 'default', name: '全體成員', members: [state.me, ...others.map((m) => m.id)] }],
  }),
  set_presence: (a) => {
    state.presence = a.presence as PresenceState;
    state.note = String(a.note);
    emit('hills://node', 'presence');
  },
  sync_status: () => (state.phase === 'pending' ? 'Pending' : 'Synced'),
  sync_now: () => undefined,
  org_code: () => code('hills-org1-' + 'y'.repeat(90)),
  create_invite: (a) => {
    invites = [
      ...invites,
      {
        id: Math.random().toString(16).slice(2, 10),
        admin: Boolean(a.admin),
        expiresAt: Date.now() + 72 * 3600_000,
        mine: true,
      },
    ];
    return code('hills1-' + 'z'.repeat(100));
  },
  invites: () => invites,
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
      kind: 'text',
      body: String(a.body),
      mentions: a.mentions as string[],
      attachments: null,
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

export const mockBackend = {
  invoke: async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    await delay();
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
