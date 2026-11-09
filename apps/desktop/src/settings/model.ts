/**
 * 設定頁的分組、搜尋索引與營地進度（ui-spec「設定」v0.37，D56）。純函式，可單元測試。
 */
import type { MessageKey } from '../i18n';

export const GROUPS = ['me', 'rhythm', 'security', 'people', 'rules', 'ai', 'about'] as const;
export type Group = (typeof GROUPS)[number];

export interface SettingItem {
  /** 卡片的 DOM id 後綴：`settings-<id>` */
  id: string;
  group: Group;
  label: MessageKey;
  /** 額外比對用的關鍵字（中英文皆可） */
  keywords: string;
  adminOnly?: boolean;
}

export const SETTING_ITEMS: SettingItem[] = [
  {
    id: 'look',
    group: 'me',
    label: 'look.title',
    keywords: 'character avatar 角色 外觀 顏色 配色 頭髮 衣服 膚色',
  },
  {
    id: 'profile',
    group: 'me',
    label: 'profile.title',
    keywords: 'name display timezone 名稱 姓名 時區',
  },
  {
    id: 'status',
    group: 'me',
    label: 'settings.status.title',
    keywords: 'status location 狀態 地點 回來',
  },
  { id: 'cafeca', group: 'me', label: 'settings.cafeca', keywords: 'cafeca account 帳戶 地址' },
  {
    id: 'language',
    group: 'rhythm',
    label: 'settings.language',
    keywords: 'language locale 語言 english 中文',
  },
  {
    id: 'scrum',
    group: 'rhythm',
    label: 'settings.scrumReminder',
    keywords: 'scrum reminder 提醒 時間',
  },
  {
    id: 'hours',
    group: 'rhythm',
    label: 'hours.title',
    keywords: 'working hours days 工作 時段 下班',
  },
  {
    id: 'notify',
    group: 'rhythm',
    label: 'notify.title',
    keywords: 'notifications 通知 提醒 私訊 指派 阻礙',
  },
  {
    id: 'devices',
    group: 'security',
    label: 'settings.devices',
    keywords: 'devices revoke 裝置 撤銷',
  },
  {
    id: 'orgCode',
    group: 'security',
    label: 'settings.orgCode',
    keywords: 'invite code qr 連線碼 邀請',
  },
  {
    id: 'backup',
    group: 'security',
    label: 'settings.backup',
    keywords: 'backup root key 備份 金鑰',
  },
  {
    id: 'joins',
    group: 'people',
    label: 'joins.title',
    keywords: 'approve join 核准 加入 還原',
    adminOnly: true,
  },
  { id: 'teams', group: 'people', label: 'teams.title', keywords: 'teams leads 小組 負責人' },
  {
    id: 'members',
    group: 'people',
    label: 'members.title',
    keywords: 'members revoke 成員 停用',
    adminOnly: true,
  },
  {
    id: 'orgName',
    group: 'rules',
    label: 'settings.orgName',
    keywords: 'organisation name 組織 名稱',
  },
  { id: 'offices', group: 'rules', label: 'offices.title', keywords: 'office lunch 辦公室 午休' },
  {
    id: 'orgScrum',
    group: 'rules',
    label: 'settings.orgScrumReminder',
    keywords: 'scrum default reminder 預設 提醒',
  },
  {
    id: 'directions',
    group: 'rules',
    label: 'settings.directions.title',
    keywords: 'direction company 公司 方向',
  },
  {
    id: 'drift',
    group: 'rules',
    label: 'settings.drift.title',
    keywords: 'drift threshold 偏離 門檻',
  },
  { id: 'mcp', group: 'ai', label: 'mcp.title', keywords: 'ai agent mcp token 代理' },
  {
    id: 'version',
    group: 'about',
    label: 'settings.version',
    keywords: 'version build commit 版本',
  },
];

/** 以名稱與關鍵字比對（不分大小寫、所有字詞都要出現）。 */
export function searchSettings(
  query: string,
  translate: (k: MessageKey) => string,
  isAdmin: boolean,
): SettingItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTING_ITEMS.filter((it) => isAdmin || !it.adminOnly).filter((it) => {
    const hay = `${translate(it.label)} ${it.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface ProgressInput {
  hasLook: boolean;
  profileSaved: boolean;
  hoursSaved: boolean;
  notifySeen: boolean;
  deviceCount: number;
  singleDevice: boolean;
  isAdmin: boolean;
  /** 本機是建立者裝置（有組織根金鑰） */
  hasOrgRoot: boolean;
  backupDone: boolean;
  /** 管理者已決定是否允許 AI 代理 */
  aiDecided: boolean;
}

export interface ProgressItem {
  key: 'look' | 'profile' | 'hours' | 'notify' | 'devices' | 'backup' | 'ai';
  group: Group;
  label: MessageKey;
  done: boolean;
}

/** 營地進度（D56）：依現況計算，不另存資料。 */
export function campProgress(p: ProgressInput): ProgressItem[] {
  const items: ProgressItem[] = [
    { key: 'look', group: 'me', label: 'progress.look', done: p.hasLook },
    { key: 'profile', group: 'me', label: 'progress.profile', done: p.profileSaved },
    { key: 'hours', group: 'rhythm', label: 'progress.hours', done: p.hoursSaved },
    { key: 'notify', group: 'rhythm', label: 'progress.notify', done: p.notifySeen },
    {
      key: 'devices',
      group: 'security',
      label: 'progress.devices',
      done: p.deviceCount > 1 || p.singleDevice,
    },
  ];
  if (p.isAdmin && p.hasOrgRoot) {
    items.push({ key: 'backup', group: 'security', label: 'progress.backup', done: p.backupDone });
  }
  if (p.isAdmin) {
    items.push({ key: 'ai', group: 'ai', label: 'progress.ai', done: p.aiDecided });
  }
  return items;
}

/** 本機的進度旗標（只影響營地進度的顯示）。 */
const FLAG_PREFIX = 'hills.progress.';
export type ProgressFlag = 'hours' | 'notify' | 'singleDevice' | 'backup' | 'ai';

export function readFlag(f: ProgressFlag): boolean {
  try {
    return localStorage.getItem(FLAG_PREFIX + f) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(f: ProgressFlag, on = true): void {
  try {
    localStorage.setItem(FLAG_PREFIX + f, on ? '1' : '0');
    window.dispatchEvent(new Event('hills-progress'));
  } catch {
    // 無法存取 storage 時只影響進度顯示
  }
}

const GROUP_KEY = 'hills.settings.group';

export function readGroup(): Group {
  try {
    const g = localStorage.getItem(GROUP_KEY);
    return (GROUPS as readonly string[]).includes(g ?? '') ? (g as Group) : 'me';
  } catch {
    return 'me';
  }
}

export function writeGroup(g: Group): void {
  try {
    localStorage.setItem(GROUP_KEY, g);
  } catch {
    // 只是記住上次的分組
  }
}

/** 角色三個部位的名稱（technical-design §16.8 v0.31 表格）。 */
export const PART_LABELS: Record<string, [MessageKey, MessageKey, MessageKey]> = {
  man: ['look.part.hair', 'look.part.shirt', 'look.part.skin'],
  woman: ['look.part.hair', 'look.part.shirt', 'look.part.skin'],
  cat: ['look.part.fur', 'look.part.shirt', 'look.part.pattern'],
  dog: ['look.part.fur', 'look.part.shirt', 'look.part.ears'],
  elephant: ['look.part.hide', 'look.part.shirt', 'look.part.earInner'],
  sheep: ['look.part.wool', 'look.part.shirt', 'look.part.face'],
  tiger: ['look.part.fur', 'look.part.shirt', 'look.part.stripes'],
};
