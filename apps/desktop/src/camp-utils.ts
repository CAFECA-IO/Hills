/** 焦點營地的純函式（ui-spec「聊天」焦點營地、technical-design §14.2 v0.14）。 */
import type { ConvRow, MemberView, MessageView, Task, TaskRefView, TaskStep } from './api';
import { defersNotifications } from './summit';

/** 訊息流的一列：一般訊息、連結任務的系統列、由步驟完成時間推導的系統列。 */
export type TimelineItem =
  | { type: 'msg'; at: number; m: MessageView }
  | { type: 'link'; at: number; m: MessageView }
  | { type: 'step'; at: number; step: TaskStep };

/**
 * 合併訊息與步驟完成列（依時間排序）。步驟只顯示落在已載入訊息時間範圍內、
 * 或最後一則訊息之後的（technical-design §14.2：由 `doneAt` 推導，不寫入對話）。
 */
export function timeline(msgs: MessageView[], task: Task | null): TimelineItem[] {
  const items: TimelineItem[] = msgs.map((m) =>
    m.kind === 'task' ? { type: 'link', at: m.createdAt, m } : { type: 'msg', at: m.createdAt, m },
  );
  const first = msgs[0]?.createdAt;
  if (task && first !== undefined) {
    for (const step of task.steps) {
      if (step.done && step.doneAt !== null && step.doneAt >= first) {
        items.push({ type: 'step', at: step.doneAt, step });
      }
    }
  }
  // 穩定排序：同一時間時訊息在前
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.at - b.it.at || a.i - b.i)
    .map(({ it }) => it);
}

/** 可「回報步驟完成」的步驟：我負責的第一個未完成步驟。 */
export function reportableStep(task: Task | null, me: string): TaskStep | null {
  return task?.steps.find((s) => !s.done && s.assignee === me) ?? null;
}

/** 找出對話連結的任務；`missing` 表示有連結但看不到（不是該小組成員或已刪除）。 */
export function resolveLinked(
  link: TaskRefView | null | undefined,
  tasks: Task[],
): { task: Task | null; missing: boolean } {
  if (!link) return { task: null, missing: false };
  const task = tasks.find((x) => x.team === link.team && x.id === link.id) ?? null;
  return { task, missing: task === null };
}

/** 敲門提示的對象：私訊看對方，群組看草稿中 @ 到的成員；只列出會延後通知的人。 */
export function knockTargets(
  conv: ConvRow,
  members: MemberView[],
  me: string,
  mentioned: string[],
  now: number,
): MemberView[] {
  const ids =
    conv.kind === 'dm'
      ? conv.members.filter((id) => id !== me)
      : mentioned.filter((id) => id !== me);
  return members.filter(
    (m) => ids.includes(m.id) && (defersNotifications(m.presence, m.until, now) || !!m.offHours),
  );
}

/** 「變成任務」的預設標題：訊息第一個非空行，去掉常見 Markdown 標記，最多 100 字。 */
export function firstLine(body: string, max = 100): string {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  return [...plain].slice(0, max).join('');
}

/** 同一作者連續訊息合併的時間窗（ui-spec「聊天」頭像與氣泡 v0.38，D58）。 */
export const RUN_GAP_MS = 5 * 60_000;

/**
 * 每一列是否顯示作者的頭像與名字：一般訊息的作者和前一列（也是一般訊息）不同、
 * 或相隔超過 5 分鐘時為 true；系統列一律 false 並打斷連續。
 */
export function runHeads(items: TimelineItem[]): boolean[] {
  return items.map((it, i) => {
    if (it.type !== 'msg') return false;
    const prev = items[i - 1];
    return !(
      prev?.type === 'msg' &&
      prev.m.author === it.m.author &&
      it.at - prev.at <= RUN_GAP_MS
    );
  });
}

/** 對話列表的預覽：最後一則訊息第一行純文字；檔案訊息回傳 null（由畫面顯示「傳送了檔案」）。 */
export function lastPreview(last: MessageView | null): string | null {
  if (!last) return '';
  if (last.kind === 'files') return null;
  return firstLine(last.body, 60);
}

/** 群組交疊頭像的兩位：最後發言者（不是我）優先，其次依成員順序。 */
export function pairOf(conv: ConvRow, me: string): string[] {
  const others = conv.members.filter((id) => id !== me);
  const lead = conv.last && conv.last.author !== me ? conv.last.author : null;
  const ordered = lead ? [lead, ...others.filter((id) => id !== lead)] : others;
  return ordered.slice(0, 2);
}
