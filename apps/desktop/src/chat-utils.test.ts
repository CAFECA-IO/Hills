import { describe, expect, it } from 'vitest';
import {
  activeMention,
  convTitle,
  extractMentions,
  filterCandidates,
  insertMention,
} from './chat-utils';

describe('mentions', () => {
  it('偵測正在輸入的提及', () => {
    expect(activeMention('hi @wa', 6)).toEqual({ start: 3, query: 'wa' });
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMention('mail@x', 6)).toBeNull();
    expect(activeMention('@wa ng', 6)).toBeNull();
  });
  it('插入提及並移動游標', () => {
    expect(insertMention('hi @wa!', 6, 3, '王小明')).toEqual({ text: 'hi @王小明 !', caret: 8 });
  });
  it('過濾候選人', () => {
    const all = [
      { id: '1', name: 'Bob' },
      { id: '2', name: 'Alice' },
      { id: '3', name: 'Albert' },
    ];
    expect(filterCandidates(all, 'al').map((c) => c.id)).toEqual(['3', '2']);
    expect(filterCandidates(all, 'b').map((c) => c.id)).toEqual(['1', '3']);
  });
  it('只保留仍在文字中的提及', () => {
    const picked = [
      { id: '1', name: 'Bob' },
      { id: '2', name: 'Alice' },
    ];
    expect(extractMentions('hi @Bob', picked)).toEqual(['1']);
    expect(extractMentions('no one', picked)).toEqual([]);
  });
  it('私訊以對方姓名為標題', () => {
    const name = (id: string) => ({ a: 'Alice', b: 'Bob' })[id] ?? id;
    expect(convTitle({ kind: 'dm', name: '', members: ['a', 'b'] }, 'a', name)).toBe('Bob');
    expect(convTitle({ kind: 'group', name: 'G', members: ['a', 'b'] }, 'a', name)).toBe('G');
  });
});
