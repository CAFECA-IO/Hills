import { describe, expect, it } from 'vitest';
import type { TeamInfo } from './api';
import {
  addMember,
  removeMember,
  removedMembers,
  rosterChanged,
  splitTeams,
  toggleLead,
} from './teams-utils';

const team = (id: string, name: string, archived = false): TeamInfo => ({
  id,
  name,
  members: ['a', 'b'],
  leads: ['a'],
  archived,
  awaitingKey: false,
  canManage: true,
});

describe('teams-utils', () => {
  it('移出成員會一併取消負責人，並列入被移出者', () => {
    const t = team('t', '工程');
    const d = removeMember({ name: t.name, members: t.members, leads: t.leads }, 'a');
    expect(d).toEqual({ name: '工程', members: ['b'], leads: [] });
    expect(removedMembers(t, d)).toEqual(['a']);
    expect(rosterChanged(t, d)).toBe(true);
  });
  it('加入成員與負責人只限成員', () => {
    const d0 = { name: 'x', members: ['a'], leads: [] };
    expect(toggleLead(d0, 'z')).toBe(d0);
    const d1 = toggleLead(addMember(d0, 'b'), 'b');
    expect(d1).toEqual({ name: 'x', members: ['a', 'b'], leads: ['b'] });
    expect(addMember(d1, 'a')).toBe(d1);
    expect(toggleLead(d1, 'b').leads).toEqual([]);
  });
  it('名單未改變（只換順序）', () => {
    const t = team('t', '工程');
    expect(rosterChanged(t, { name: '新名稱', members: ['b', 'a'], leads: ['a'] })).toBe(false);
    expect(removedMembers(t, { name: '', members: ['b', 'a'], leads: [] })).toEqual([]);
  });
  it('封存的小組分開列出', () => {
    const s = splitTeams([team('2', 'Sales'), team('1', 'Expo', true), team('3', 'Eng')]);
    expect(s.active.map((x) => x.id)).toEqual(['3', '2']);
    expect(s.archived.map((x) => x.id)).toEqual(['1']);
  });
});
