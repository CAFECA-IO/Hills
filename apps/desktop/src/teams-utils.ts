/** 小組名單編輯（ui-spec「設定 → 小組」，D49；technical-design §16.15）。 */
import type { TeamInfo } from './api';

export interface RosterDraft {
  name: string;
  members: string[];
  leads: string[];
}

/** 這次儲存會被移出的人（原本在名單上、草稿中不在）。 */
export function removedMembers(before: Pick<TeamInfo, 'members' | 'leads'>, after: RosterDraft) {
  const old = [...new Set([...before.members, ...before.leads])];
  return old.filter((m) => !after.members.includes(m));
}

/** 加入成員（已在名單則不變）。 */
export function addMember(d: RosterDraft, id: string): RosterDraft {
  return d.members.includes(id) ? d : { ...d, members: [...d.members, id] };
}

/** 移出成員，同時取消負責人。 */
export function removeMember(d: RosterDraft, id: string): RosterDraft {
  return {
    ...d,
    members: d.members.filter((m) => m !== id),
    leads: d.leads.filter((m) => m !== id),
  };
}

/** 切換負責人（只限成員）。 */
export function toggleLead(d: RosterDraft, id: string): RosterDraft {
  if (!d.members.includes(id)) return d;
  return d.leads.includes(id)
    ? { ...d, leads: d.leads.filter((m) => m !== id) }
    : { ...d, leads: [...d.leads, id] };
}

/** 名單是否改變（不計順序）。 */
export function rosterChanged(before: Pick<TeamInfo, 'members' | 'leads'>, after: RosterDraft) {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  return !same(before.members, after.members) || !same(before.leads, after.leads);
}

/** 列表排序：未封存在前，依名稱。 */
export function splitTeams(teams: TeamInfo[]) {
  const byName = (a: TeamInfo, b: TeamInfo) => a.name.localeCompare(b.name);
  return {
    active: teams.filter((x) => !x.archived).sort(byName),
    archived: teams.filter((x) => x.archived).sort(byName),
  };
}
