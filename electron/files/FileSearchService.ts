import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileSearchResult } from '@shared/types/files.js';
import type { SettingsBinaries } from '@shared/types/settings.js';

export interface FileSearchServiceOptions {
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
}

interface CommandResult {
  code: number | null;
  stdout: string;
}

export class FileSearchService {
  constructor(private readonly opts: FileSearchServiceOptions = {}) {}

  async search(rootPath: string, query: string, limit = 80): Promise<FileSearchResult[]> {
    const root = rootPath.trim();
    if (!root) return [];
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }

    const files = await this.listFiles(root);
    const q = query.trim();
    const ranked = q
      ? rank(q, files)
      : files.map((file, index) => ({ file, score: 1000 - index }));
    return ranked.slice(0, Math.max(1, Math.min(200, Math.trunc(limit)))).map(({ file }) => ({
      rootPath: root,
      path: file,
      absolutePath: path.resolve(root, file)
    }));
  }

  private async listFiles(rootPath: string): Promise<string[]> {
    const binaries = this.opts.getBinaries ? await this.opts.getBinaries() : {};
    const git = binaries.git ?? 'git';
    const gitFiles = await run(rootPath, git, ['ls-files', '--cached', '--others', '--exclude-standard']);
    if (gitFiles.code === 0 && gitFiles.stdout.trim()) return uniqueLines(gitFiles.stdout);

    const fd = binaries.fd ?? 'fd';
    const fdFiles = await run(rootPath, fd, ['--type', 'f', '--strip-cwd-prefix', '.']);
    if (fdFiles.code === 0 && fdFiles.stdout.trim()) return uniqueLines(fdFiles.stdout);

    const rg = binaries.rg ?? 'rg';
    const rgFiles = await run(rootPath, rg, ['--files']);
    if (rgFiles.code === 0 && rgFiles.stdout.trim()) return uniqueLines(rgFiles.stdout);

    return this.walk(rootPath);
  }

  private async walk(rootPath: string): Promise<string[]> {
    const out: string[] = [];
    const queue = [''];
    while (queue.length > 0 && out.length < 5000) {
      const rel = queue.shift()!;
      const dir = path.join(rootPath, rel);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const next = path.join(rel, entry.name);
        if (entry.isDirectory()) queue.push(next);
        if (entry.isFile()) out.push(next.replace(/\\/g, '/'));
      }
    }
    return out;
  }
}

function rank(query: string, files: string[]): Array<{ file: string; score: number }> {
  return files
    .map((file) => ({ file, score: score(query, file) }))
    .filter((item): item is { file: string; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function score(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let total = 0;
  let last = -1;
  for (let i = 0; i < c.length && qi < q.length; i += 1) {
    if (c[i] !== q[qi]) continue;
    total += i === qi ? 10 : 2;
    if (last >= 0 && i === last + 1) total += 5;
    if (i === 0 || /[/_.-]/.test(candidate[i - 1] ?? '')) total += 4;
    last = i;
    qi += 1;
  }
  if (qi !== q.length) return null;
  return total - candidate.length / 100;
}

function uniqueLines(output: string): string[] {
  return [...new Set(output.split('\n').map((line) => line.trim()).filter(Boolean))];
}

function run(cwd: string, file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(file, args, { cwd });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}
