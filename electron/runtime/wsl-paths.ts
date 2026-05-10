import { spawn } from 'node:child_process';

const HOME_CACHE = new Map<string, string>();

export function posixToWslUnc(distro: string, posixPath: string): string {
  const noLead = posixPath.replace(/^\/+/, '');
  const winSubpath = noLead.replace(/\//g, '\\');
  return winSubpath
    ? `\\\\wsl.localhost\\${distro}\\${winSubpath}`
    : `\\\\wsl.localhost\\${distro}\\`;
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
