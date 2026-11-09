import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import { campProgress, searchSettings, SETTING_ITEMS, GROUPS, type ProgressInput } from './model';

const zh = (k: Parameters<typeof translate>[1]) => translate('zh-TW', k);

describe('settings search', () => {
  it('matches labels and keywords, all words required', () => {
    expect(searchSettings('通知', zh, false).map((i) => i.id)).toContain('notify');
    expect(searchSettings('timezone', zh, false).map((i) => i.id)).toEqual(['profile']);
    expect(searchSettings('scrum 預設', zh, true).map((i) => i.id)).toEqual(['orgScrum']);
    expect(searchSettings('   ', zh, true)).toEqual([]);
  });

  it('hides admin-only items from members', () => {
    expect(searchSettings('核准', zh, false)).toEqual([]);
    expect(searchSettings('核准', zh, true).map((i) => i.id)).toEqual(['joins']);
  });

  it('every item belongs to a known group', () => {
    for (const it of SETTING_ITEMS) expect(GROUPS).toContain(it.group);
  });
});

describe('camp progress', () => {
  const base: ProgressInput = {
    hasLook: true,
    profileSaved: true,
    hoursSaved: false,
    notifySeen: true,
    deviceCount: 1,
    singleDevice: false,
    isAdmin: false,
    hasOrgRoot: false,
    backupDone: false,
    aiDecided: false,
  };

  it('members have five items', () => {
    const p = campProgress(base);
    expect(p).toHaveLength(5);
    expect(p.filter((i) => i.done).map((i) => i.key)).toEqual(['look', 'profile', 'notify']);
  });

  it('a second device or opting out completes devices', () => {
    expect(campProgress({ ...base, deviceCount: 2 }).find((i) => i.key === 'devices')?.done).toBe(
      true,
    );
    expect(
      campProgress({ ...base, singleDevice: true }).find((i) => i.key === 'devices')?.done,
    ).toBe(true);
  });

  it('admins on the creator device also back up and decide on AI', () => {
    const p = campProgress({ ...base, isAdmin: true, hasOrgRoot: true });
    expect(p.map((i) => i.key)).toEqual([
      'look',
      'profile',
      'hours',
      'notify',
      'devices',
      'backup',
      'ai',
    ]);
    expect(campProgress({ ...base, isAdmin: true }).map((i) => i.key)).not.toContain('backup');
  });
});
