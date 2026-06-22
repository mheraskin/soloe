import { spawn } from 'node:child_process';

const HOME_CACHE = new Map<string, string>();

export function posixToWslUnc(distro: string, posixPath: string): string {
  const noLead = posixPath.replace(/^\/+/, '');
  const winSubpath = noLead.replace(/\//g, '\\');
  return winSubpath
    ? `\\\\wsl.localhost\\${distro}\\${winSubpath}`
    : `\\\\wsl.localhost\\${distro}\\`;
}

// Map a WSL DrvFs mount (/mnt/<drive>/...) to its native Windows path, e.g.
// /mnt/d/projects -> D:\projects, /mnt/c -> C:\. Returns null for anything that
// isn't a single-letter drive mount (so /mnt, /mnt/wsl, /home/... fall through).
//
// Needed because the \\wsl.localhost 9p share cannot enumerate into DrvFs
// mounts: readdir on \\wsl.localhost\<distro>\mnt\d comes back empty, which
// silently broke path suggestions below /mnt/<drive>. On a Windows host the
// drive is reachable directly, so list it through the native path instead.
export function mntPosixToWindows(posixPath: string): string | null {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(posixPath.replace(/\/+$/, ''));
  if (!match) return null;
  const drive = match[1]!.toUpperCase();
  const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

export function runWslCommand(distro: string, bashLine: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-lc', bashLine],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve('');
    }, 2500);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

export async function resolveWslHome(distro: string): Promise<string> {
  const cached = HOME_CACHE.get(distro);
  if (cached) return cached;
  const home = await runWslCommand(distro, 'printf %s "$HOME"');
  const resolved = home.trim() || '/root';
  HOME_CACHE.set(distro, resolved);
  return resolved;
}
