import { app, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { IpcChannels } from '@shared/types/ipc.js';
import type { SessionId } from '@shared/types/sessions.js';
import type { SystemUsageRequest, SystemUsageSnapshot } from '@shared/types/system.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import { ResourceUsageObservation } from '../diagnostics/ResourceUsageObservation.js';
import { WslUsageSampler } from '../diagnostics/WslUsageSampler.js';
import { platformInfo } from '@shared/platform.js';
import { ipcInvoke } from './result.js';

export interface SystemIpcOptions {
  store: SessionStore;
  getRunningWslDistros?: () => Promise<string[]>;
}

export class SystemIpc {
  private registered = false;
  private readonly wslUsage: WslUsageSampler;
  private readonly usage: ResourceUsageObservation;

  constructor(private readonly opts: SystemIpcOptions) {
    this.wslUsage = new WslUsageSampler();
    this.usage = new ResourceUsageObservation({
      collectAppUsage,
      getRunningWslDistros: () => this.getRunningWslDistros(),
      sampleWsl: (distroCount) => this.wslUsage.sample(distroCount),
      resetWsl: () => this.wslUsage.reset()
    });
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.system.platform, () =>
      ipcInvoke(async () => platformInfo())
    );

    ipcMain.handle(IpcChannels.system.openPath, (_e, sessionId: SessionId) =>
      ipcInvoke(async () => {
        const session = await this.opts.store.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        if (session.runMode === 'wsl') {
          if (!session.wslDistro) throw new Error('Session has no wslDistro');
          await openInWsl(session.wslDistro, session.cwd);
        } else {
          const result = await shell.openPath(session.cwd);
          if (result) throw new Error(result);
        }
        return true as const;
      })
    );

    ipcMain.handle(
      IpcChannels.system.saveText,
      (_e, request: { defaultPath?: string; content: string }) =>
        ipcInvoke(async () => {
          const result = await dialog.showSaveDialog({
            ...(request.defaultPath ? { defaultPath: request.defaultPath } : {}),
            filters: [{ name: 'Text', extensions: ['txt', 'log', 'md'] }]
          });
          if (result.canceled || !result.filePath) return true as const;
          await fs.writeFile(result.filePath, request.content, 'utf8');
          return true as const;
        })
    );

    ipcMain.handle(IpcChannels.system.openExternal, (_e, url: string) =>
      ipcInvoke(async () => {
        await shell.openExternal(url);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.system.listWslDistros, () =>
      ipcInvoke(() => listWslDistros())
    );

    ipcMain.handle(IpcChannels.system.usage, (_event, request?: SystemUsageRequest) =>
      ipcInvoke(() => this.usage.observe(request))
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.system.platform);
    ipcMain.removeHandler(IpcChannels.system.openPath);
    ipcMain.removeHandler(IpcChannels.system.saveText);
    ipcMain.removeHandler(IpcChannels.system.openExternal);
    ipcMain.removeHandler(IpcChannels.system.listWslDistros);
    ipcMain.removeHandler(IpcChannels.system.usage);
    this.usage.reset();
    this.registered = false;
  }

  private async getRunningWslDistros(): Promise<string[]> {
    try {
      return await (this.opts.getRunningWslDistros?.() ?? Promise.resolve([]));
    } catch {
      return [];
    }
  }
}

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
}

async function collectAppUsage(): Promise<Omit<SystemUsageSnapshot, 'wslActive' | 'wsl'>> {
  const electronMetrics = app.getAppMetrics();
  const electronByPid = new Map(electronMetrics.map((metric) => [metric.pid, metric]));
  const rows = await listProcessRows();
  const rootPids = new Set([process.pid]);
  const selectedPids = new Set([
    ...electronByPid.keys(),
    ...collectDescendantPids(rows, rootPids)
  ]);

  let cpuPercent = 0;
  let memoryBytes = 0;

  for (const pid of selectedPids) {
    const electronMetric = electronByPid.get(pid);
    if (electronMetric) {
      cpuPercent += electronMetric.cpu.percentCPUUsage;
      memoryBytes += electronMetric.memory.workingSetSize * 1024;
      continue;
    }

    const row = rows.get(pid);
    if (!row) continue;
    cpuPercent += row.cpuPercent;
    memoryBytes += row.rssKb * 1024;
  }

  const electronProcessCount = electronByPid.size;
  const processCount = selectedPids.size;

  return {
    scope: 'client',
    availability: 'available',
    backendPlacement: null,
    cpuPercent: round(cpuPercent, 1),
    memoryBytes,
    processCount,
    electronProcessCount,
    childProcessCount: Math.max(0, processCount - electronProcessCount),
    components: [
      {
        kind: 'electron',
        availability: 'available',
        cpuPercent: round(
          [...electronByPid.values()].reduce(
            (total, metric) => total + metric.cpu.percentCPUUsage,
            0
          ),
          1
        ),
        memoryBytes: [...electronByPid.values()].reduce(
          (total, metric) => total + metric.memory.workingSetSize * 1024,
          0
        ),
        processCount: electronProcessCount
      },
      {
        kind: 'client-child',
        availability: 'available',
        cpuPercent: round(
          [...selectedPids]
            .filter((pid) => !electronByPid.has(pid))
            .reduce((total, pid) => total + (rows.get(pid)?.cpuPercent ?? 0), 0),
          1
        ),
        memoryBytes: [...selectedPids]
          .filter((pid) => !electronByPid.has(pid))
          .reduce((total, pid) => total + (rows.get(pid)?.rssKb ?? 0) * 1024, 0),
        processCount: Math.max(0, processCount - electronProcessCount)
      }
    ],
    sampledAt: new Date().toISOString()
  };
}

function collectDescendantPids(rows: Map<number, ProcessRow>, rootPids: Set<number>): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows.values()) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const selected = new Set<number>();
  const queue = [...rootPids];
  for (let i = 0; i < queue.length; i += 1) {
    const pid = queue[i];
    if (pid === undefined) continue;
    if (selected.has(pid)) continue;
    selected.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return [...selected];
}

async function listProcessRows(): Promise<Map<number, ProcessRow>> {
  if (process.platform === 'win32') return new Map();
  return new Promise((resolve) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(new Map());
    }, 1500);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(new Map());
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(parsePsRows(stdout));
    });
  });
}

function parsePsRows(output: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)$/);
    if (!match) continue;
    const [, pid, ppid, rssKb, cpuPercent] = match;
    rows.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rssKb),
      cpuPercent: Number(cpuPercent)
    });
  }
  return rows;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
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

function parseWslDistros(output: string): string[] {
  return [...new Set(
    output
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+\(Default\)$/i, ''))
      .filter(Boolean)
  )];
}

function openInWsl(distro: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--cd', cwd, '--', 'explorer.exe', '.'],
      { detached: true, stdio: 'ignore' }
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
