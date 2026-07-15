import { spawn } from 'node:child_process';
import { posixToWslUnc } from '../runtime/wsl-paths.js';

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
  return posixToWslUnc(distro, linuxPath);
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

// Resolves the hostname an MCP client running inside `distro` should use to
// reach the Windows host. Mirrors the runtime fallback chain in
// HookInstaller's hook command: prefer `host.wsl.internal` when DNS resolves,
// otherwise the default-route gateway IP, otherwise the resolv.conf
// nameserver. Returns `host.wsl.internal` on probe failure as a best-effort
// default rather than throwing — the caller can always retry next boot.
//
// Why stdin instead of `bash -c '<script>'`: wsl.exe pre-expands any `$VAR`
// reference in a command-line argument using the *Windows* environment before
// bash receives it, so locally-defined shell vars (`$ip`, awk's `$3`, etc.)
// get clobbered to empty and `${ip:-host.wsl.internal}` always returned the
// literal default. Feeding the script over stdin to `bash -s` keeps the body
// opaque to that layer.
export function probeWslMcpHostname(distro: string): Promise<string> {
  const script =
    'if getent hosts host.wsl.internal >/dev/null 2>&1; then\n' +
    '  printf %s host.wsl.internal\n' +
    'else\n' +
    "  ip=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')\n" +
    "  [ -z \"$ip\" ] && ip=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)\n" +
    '  printf %s "${ip:-host.wsl.internal}"\n' +
    'fi\n';
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-s'],
      { stdio: ['pipe', 'pipe', 'ignore'] }
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve('host.wsl.internal');
    }, 5000);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('host.wsl.internal');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve('host.wsl.internal');
        return;
      }
      const out = stdout.trim();
      resolve(out || 'host.wsl.internal');
    });
    child.stdin?.end(script);
  });
}
