import { spawn } from 'node:child_process';

export interface WslDistroInfo {
  distro: string;
  /** Home directory as a Windows-reachable UNC path, e.g. \\wsl.localhost\Ubuntu\home\mhera */
  homeUnc: string | null;
  /** Linux-side home path, e.g. /home/user */
  homeLinux: string | null;
  available: boolean;
  reason?: string;
}

export class WslHostDetector {
  async detect(): Promise<WslDistroInfo[]> {
    if (process.platform !== 'win32') return [];
    const distros = await listWslDistros();
    const results = await Promise.all(distros.map((distro) => this.detectOne(distro)));
    return results;
  }

  private async detectOne(distro: string): Promise<WslDistroInfo> {
    const homeLinux = await getWslHome(distro);
    if (!homeLinux) {
      return {
        distro,
        homeUnc: null,
        homeLinux: null,
        available: false,
        reason: 'unable to read $HOME from distro'
      };
    }
    return {
      distro,
      homeUnc: linuxPathToUnc(distro, homeLinux),
      homeLinux,
      available: true
    };
  }
}

export function linuxPathToUnc(distro: string, linuxPath: string): string {
  const segments = linuxPath.split('/').filter((s) => s.length > 0);
  return ['\\\\wsl.localhost', distro, ...segments].join('\\');
}

function listWslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-l', '-q'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve([]);
    }, 2500);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf16le');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve([]);
        return;
      }
      resolve(parseWslDistros(stdout));
    });
  });
}

export function parseWslDistros(output: string): string[] {
  return [
    ...new Set(
      output
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\s+\(Default\)$/i, ''))
        .filter(Boolean)
    )
  ];
}

function getWslHome(distro: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-c', 'printf %s "$HOME"'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5000);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const home = stdout.trim();
      resolve(home || null);
    });
  });
}
