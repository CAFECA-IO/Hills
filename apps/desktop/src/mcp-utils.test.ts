import { describe, expect, it } from 'vitest';
import type { MemberView } from './api';
import { isDangerous, previewLines } from './mcp-utils';

const members = [{ id: 'mem-d', name: '林小美' }] as MemberView[];

describe('previewLines', () => {
  it('任務顯示標題、負責人名字與期限', () => {
    const [line] = previewLines(
      {
        action: 'createTask',
        title: '匯入台灣行事曆',
        assignee: 'mem-d',
        dueAt: Date.UTC(2026, 10, 13, 4),
      },
      members,
    );
    expect(line).toContain('匯入台灣行事曆');
    expect(line).toContain('林小美');
    expect(line).toContain('11/13');
  });

  it('訊息顯示對話與內容；找不到成員時顯示 id', () => {
    const lines = previewLines({ action: 'message', conv: '產品討論', text: '嗨' }, members);
    expect(lines[0]).toContain('產品討論');
    expect(lines[1]).toBe('嗨');
    expect(
      previewLines({ action: 'createTask', title: 'x', assignee: 'mem-z' }, members)[0],
    ).toContain('mem-z');
  });

  it('刪除顯示標題', () => {
    expect(
      previewLines({ action: 'deleteGoal', period: '2026-W46', title: '檔案分享穩定' }, members)[0],
    ).toContain('檔案分享穩定');
    expect(
      previewLines(
        { action: 'deleteTask', title: '匯入台灣行事曆', assignee: 'mem-d' },
        members,
      )[0],
    ).toContain('林小美');
  });

  it('私訊顯示對象姓名，群組顯示人數', () => {
    expect(
      previewLines({ action: 'message', conv: '', to: 'mem-d', count: 2, text: '嗨' }, members)[0],
    ).toContain('林小美');
    expect(
      previewLines({ action: 'message', conv: 'AquaMind', count: 10, text: '嗨' }, members)[0],
    ).toContain('10');
  });

  it('任務狀態、接下與困難', () => {
    expect(
      previewLines({ action: 'taskStatus', title: 'B2', status: 'done' }, members)[0],
    ).toContain('Done');
    expect(
      previewLines({ action: 'taskAck', title: 'B2', state: 'accepted' }, members)[0],
    ).toContain('Accept');
    expect(
      previewLines(
        { action: 'taskAck', title: 'B3', state: 'concern', text: '缺帳號' },
        members,
      )[0],
    ).toContain('缺帳號');
  });

  it('修改小組列出被移出的人並用 danger', () => {
    const p = {
      action: 'updateTeam' as const,
      team: 'AquaMind',
      title: 'AquaMind',
      count: 9,
      leads: ['mem-d'],
      removed: ['mem-d'],
    };
    const lines = previewLines(p, members);
    expect(lines[0]).toContain('AquaMind');
    expect(lines[1]).toContain('林小美');
    expect(isDangerous(p)).toBe(true);
    expect(isDangerous({ ...p, removed: [] })).toBe(false);
    expect(isDangerous({ action: 'archiveTeam', team: 'x' })).toBe(true);
    expect(isDangerous({ action: 'deleteTeamGoal' })).toBe(true);
  });

  it('小組目標與知識主題', () => {
    expect(
      previewLines(
        { action: 'createTeamGoal', team: 'AquaMind', period: '2026', title: 'DEMO 通過' },
        members,
      )[0],
    ).toBe('AquaMind · 2026 · "DEMO 通過"');
    expect(
      previewLines({ action: 'createKbTopic', title: '設備清單', parent: 'AquaMind' }, members)[0],
    ).toContain('AquaMind');
  });
});
