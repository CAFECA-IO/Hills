import { describe, expect, it } from 'vitest';
import type { MemberView } from './api';
import { previewLines } from './mcp-utils';

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
});
