/** 對話的純函式工具（可單元測試）。 */

export interface MentionCandidate {
  id: string;
  name: string;
}

/** 游標前正在輸入的 @ 提及（`@` 後到游標為止、不含空白），沒有則回傳 null。 */
export function activeMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** 以選定的成員取代正在輸入的提及，回傳新文字與游標位置。 */
export function insertMention(
  text: string,
  caret: number,
  start: number,
  name: string,
): { text: string; caret: number } {
  const insert = `@${name} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

/** 依名稱過濾候選人（不分大小寫，前綴優先）。 */
export function filterCandidates<T extends MentionCandidate>(
  all: T[],
  query: string,
  limit = 6,
): T[] {
  const q = query.toLowerCase();
  const scored = all
    .map((c) => ({ c, i: c.name.toLowerCase().indexOf(q) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

/** 送出時實際保留在文字中的提及（`@名稱` 仍存在者）。 */
export function extractMentions(body: string, picked: MentionCandidate[]): string[] {
  const ids = new Set<string>();
  for (const p of picked) {
    if (body.includes(`@${p.name}`)) ids.add(p.id);
  }
  return [...ids];
}

/** 對話顯示名稱：群組用名稱；私訊用對方姓名。 */
export function convTitle(
  conv: { kind: string; name: string; members: string[] },
  me: string,
  nameOf: (id: string) => string,
): string {
  if (conv.kind === 'group') return conv.name;
  const other = conv.members.find((m) => m !== me);
  return other ? nameOf(other) : conv.name;
}
