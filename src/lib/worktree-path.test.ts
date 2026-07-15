import { describe, expect, it } from 'vitest';
import {
  sameWorktreePath,
  worktreeBasename,
  worktreeLabel,
  worktreePathKey
} from './worktree-path';

describe('Worktree path identity', () => {
  it('normalizes Windows case, separators, whitespace, and trailing separators', () => {
    expect(worktreePathKey(' C:\\Code\\SoloE\\ ', 'windows')).toBe('c:/code/soloe');
    expect(sameWorktreePath('C:\\Code\\SoloE', 'c:/code/soloe/', 'windows')).toBe(true);
  });

  it('preserves WSL case sensitivity', () => {
    expect(sameWorktreePath('/home/me/Soloe/', '/home/me/soloe', 'wsl')).toBe(false);
    expect(worktreePathKey('/', 'wsl')).toBe('/');
  });

  it('derives labels without lowercasing their display spelling', () => {
    expect(worktreeLabel('C:\\Code', 'c:\\CODE\\Feature-X', 'windows')).toBe('Feature-X');
    expect(worktreeLabel('/home/me/repo', '/home/me/repo', 'wsl')).toBe('main');
    expect(worktreeBasename('/home/me/feature')).toBe('feature');
  });
});
