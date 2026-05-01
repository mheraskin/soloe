import { describe, it, expect } from 'vitest';
import { score, rank, rankMulti } from './fuzzy';

describe('fuzzy — score', () => {
  it('empty query: returns 0', () => {
    expect(score('', 'anything')).toBe(0);
  });

  it('subsequence match: returns positive', () => {
    expect(score('abc', 'aXbXc')).toBeGreaterThan(0);
  });

  it('non-subsequence: returns null', () => {
    expect(score('xyz', 'abc')).toBeNull();
  });

  it('case-insensitive', () => {
    expect(score('AbC', 'abc')).not.toBeNull();
  });

  it('prefix match scores higher than mid-string match', () => {
    const prefix = score('abc', 'abc-thing')!;
    const mid = score('abc', 'x-abc-thing')!;
    expect(prefix).toBeGreaterThan(mid);
  });

  it('contiguous match scores higher than scattered', () => {
    const cont = score('abc', 'zabc')!;
    const scat = score('abc', 'aXbXcZ')!;
    expect(cont).toBeGreaterThan(scat);
  });
});

describe('fuzzy — rank', () => {
  it('returns items sorted by score desc, drops non-matches', () => {
    const items = ['claude-main', 'codex-feature', 'terminal', 'claude-feat'];
    const r = rank('cla', items, (s) => s);
    expect(r.map((x) => x.item)).toEqual(['claude-main', 'claude-feat']);
  });
});

describe('fuzzy — rankMulti', () => {
  it('uses best key score', () => {
    const items = [
      { name: 'session-a', cwd: '/repo/foo' },
      { name: 'session-b', cwd: '/elsewhere' }
    ];
    const r = rankMulti('foo', items, (it) => [it.name, it.cwd]);
    expect(r[0]?.item.name).toBe('session-a');
  });

  it('drops items with no key matching', () => {
    const items = [{ name: 'foo' }, { name: 'bar' }];
    const r = rankMulti('xyz', items, (it) => [it.name]);
    expect(r).toEqual([]);
  });
});
