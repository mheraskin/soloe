import { describe, expect, it } from 'vitest';
import {
  sameWorktreeIdentity,
  worktreeIdentity,
  worktreeIdentityKey,
  worktreeRuntimeContext,
  worktreeScope,
  worktreeScopeKey,
  worktreeRuntimeKey
} from './worktree-identity.js';

describe('Worktree Identity', () => {
  it('normalizes Windows spelling while preserving the display path', () => {
    const identity = worktreeIdentity(' C:\\Code\\SoloE\\ ', { runMode: 'windows' });
    expect(identity.path).toBe('C:/Code/SoloE');
    expect(identity.pathKey).toBe('c:/code/soloe');
    expect(worktreeIdentityKey('c:/code/soloe', { runMode: 'windows' })).toBe(identity.key);
  });

  it('isolates identical Linux paths in different WSL distros', () => {
    const ubuntu = worktreeIdentityKey('/home/me/repo', {
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    const debian = worktreeIdentityKey('/home/me/repo', {
      runMode: 'wsl',
      wslDistro: 'Debian'
    });
    expect(ubuntu).not.toBe(debian);
    expect(sameWorktreeIdentity(
      '/home/me/repo/',
      { runMode: 'wsl', wslDistro: 'ubuntu' },
      '/home/me/repo',
      { runMode: 'wsl', wslDistro: 'Ubuntu' }
    )).toBe(true);
  });

  it('projects an immutable scope into identity and execution context', () => {
    const scope = worktreeScope('/home/me/repo/', {
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(scope).toEqual({
      cwd: '/home/me/repo/',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(worktreeScopeKey(scope)).toBe(
      worktreeIdentityKey('/home/me/repo', { runMode: 'wsl', wslDistro: 'Ubuntu' })
    );
    expect(worktreeRuntimeContext(scope)).toEqual({
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(worktreeRuntimeContext(scope)).not.toHaveProperty('cwd');
  });

  it('does not alias an unknown POSIX runtime with a WSL Worktree', () => {
    expect(worktreeIdentityKey('/repo')).not.toBe(
      worktreeIdentityKey('/repo', { runMode: 'wsl', wslDistro: 'Ubuntu' })
    );
  });

  it('ignores an irrelevant distro for Windows identity', () => {
    expect(worktreeRuntimeKey({ runMode: 'windows', wslDistro: 'ignored' })).toBe(
      worktreeRuntimeKey({ runMode: 'windows' })
    );
  });
});
