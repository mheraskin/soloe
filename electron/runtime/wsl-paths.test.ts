import { describe, expect, it } from 'vitest';
import {
  joinHostPath,
  mntPosixToWindows,
  posixToWslUnc,
  worktreeHostPath
} from './wsl-paths.js';

describe('mntPosixToWindows', () => {
  it('maps a drive mount root to a Windows drive root', () => {
    expect(mntPosixToWindows('/mnt/d')).toBe('D:\\');
    expect(mntPosixToWindows('/mnt/c')).toBe('C:\\');
  });

  it('maps a nested mount path and upcases the drive', () => {
    expect(mntPosixToWindows('/mnt/d/projects/soloe')).toBe('D:\\projects\\soloe');
  });

  it('tolerates trailing slashes', () => {
    expect(mntPosixToWindows('/mnt/d/')).toBe('D:\\');
    expect(mntPosixToWindows('/mnt/d/projects/')).toBe('D:\\projects');
  });

  it('preserves spaces in the path', () => {
    expect(mntPosixToWindows('/mnt/e/my files')).toBe('E:\\my files');
  });

  it('returns null for non-drive-mount paths', () => {
    expect(mntPosixToWindows('/mnt')).toBeNull();
    expect(mntPosixToWindows('/mnt/wsl')).toBeNull();
    expect(mntPosixToWindows('/mnt/wslg/foo')).toBeNull();
    expect(mntPosixToWindows('/home/me/projects')).toBeNull();
    expect(mntPosixToWindows('~/projects')).toBeNull();
  });
});

describe('posixToWslUnc', () => {
  it('builds a \\\\wsl.localhost UNC for a distro path', () => {
    expect(posixToWslUnc('Ubuntu', '/home/me')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me');
  });

  it('handles the distro root', () => {
    expect(posixToWslUnc('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\');
  });
});

describe('worktreeHostPath', () => {
  it('uses the native drive for WSL worktrees under DrvFs on Windows', () => {
    expect(worktreeHostPath('/mnt/c/Users/me/repo', 'wsl', 'Ubuntu', 'win32'))
      .toBe('C:\\Users\\me\\repo');
  });

  it('uses the distro UNC share for Linux filesystem worktrees on Windows', () => {
    expect(worktreeHostPath('/home/me/repo', 'wsl', 'Ubuntu', 'win32'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
  });

  it('leaves native paths and non-Windows hosts unchanged', () => {
    expect(worktreeHostPath('C:\\repo', 'windows', undefined, 'win32')).toBe('C:\\repo');
    expect(worktreeHostPath('C:\\repo', 'wsl', 'Ubuntu', 'win32')).toBe('C:\\repo');
    expect(worktreeHostPath('\\\\server\\share\\repo', 'wsl', 'Ubuntu', 'win32'))
      .toBe('\\\\server\\share\\repo');
    expect(worktreeHostPath('/home/me/repo', 'wsl', 'Ubuntu', 'linux')).toBe('/home/me/repo');
  });

  it('rejects a Windows-hosted WSL context without a distro', () => {
    expect(() => worktreeHostPath('/home/me/repo', 'wsl', undefined, 'win32'))
      .toThrow('WSL distro');
    expect(() => worktreeHostPath('/home/me/repo', 'wsl', '  ', 'win32'))
      .toThrow('WSL distro');
  });
});

describe('joinHostPath', () => {
  it('uses Windows separators for drive and UNC host paths', () => {
    expect(joinHostPath('C:\\repo', 'docs', 'plans')).toBe('C:\\repo\\docs\\plans');
    expect(joinHostPath('\\\\wsl.localhost\\Ubuntu\\home\\me', 'docs', 'plans'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\docs\\plans');
  });

  it('uses POSIX separators for POSIX host paths on every host', () => {
    expect(joinHostPath('/home/me/repo', 'docs', 'plans')).toBe('/home/me/repo/docs/plans');
  });
});
