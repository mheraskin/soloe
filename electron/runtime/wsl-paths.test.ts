import { describe, expect, it } from 'vitest';
import { mntPosixToWindows, posixToWslUnc } from './wsl-paths.js';

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
