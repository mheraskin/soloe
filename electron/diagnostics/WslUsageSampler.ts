import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { WslUsageSnapshot } from '@shared/types/system.js';

interface WslKernelSnapshot {
  totalTicks: number;
  busyTicks: number;
  memoryBytes: number;
  memoryTotalBytes: number;
}

interface WslUsageSamplerOptions {
  probe?: () => Promise<string | null>;
  now?: () => Date;
}

const PROBE_TIMEOUT_MS = 2000;
const MAX_PROBE_OUTPUT = 128 * 1024;

export class WslUsageSampler {
  private previous: WslKernelSnapshot | null = null;
  private readonly probe: () => Promise<string | null>;
  private readonly now: () => Date;

  constructor(options: WslUsageSamplerOptions = {}) {
    this.probe = options.probe ?? probeWslKernel;
    this.now = options.now ?? (() => new Date());
  }

  async sample(distroCount: number): Promise<WslUsageSnapshot | null> {
    if (distroCount <= 0) {
      this.reset();
      return null;
    }
    const raw = await this.probe();
    const current = raw ? parseWslKernelSnapshot(raw) : null;
    if (!current) {
      this.reset();
      return null;
    }
    const cpuPercent = this.previous
      ? cpuPercentBetween(this.previous, current)
      : null;
    this.previous = current;
    return {
      cpuPercent,
      memoryBytes: current.memoryBytes,
      memoryTotalBytes: current.memoryTotalBytes,
      distroCount,
      sampledAt: this.now().toISOString()
    };
  }

  reset(): void {
    this.previous = null;
  }
}

export function parseWslKernelSnapshot(raw: string): WslKernelSnapshot | null {
  const cpuLine = raw.split(/\r?\n/u).find((line) => /^cpu\s+/u.test(line));
  if (!cpuLine) return null;
  const counters = cpuLine.trim().split(/\s+/u).slice(1).map(Number);
  if (counters.length < 5 || counters.some((value) => !Number.isFinite(value))) return null;

  const user = counters[0] ?? 0;
  const nice = counters[1] ?? 0;
  const system = counters[2] ?? 0;
  const idle = counters[3] ?? 0;
  const ioWait = counters[4] ?? 0;
  const irq = counters[5] ?? 0;
  const softIrq = counters[6] ?? 0;
  const steal = counters[7] ?? 0;
  const idleTicks = idle + ioWait;
  const busyTicks = user + nice + system + irq + softIrq + steal;
  const totalTicks = idleTicks + busyTicks;

  const memoryTotalKb = meminfoValue(raw, 'MemTotal');
  const memoryAvailableKb = meminfoValue(raw, 'MemAvailable');
  if (memoryTotalKb === null || memoryAvailableKb === null) return null;

  return {
    totalTicks,
    busyTicks,
    memoryBytes: Math.max(0, memoryTotalKb - memoryAvailableKb) * 1024,
    memoryTotalBytes: memoryTotalKb * 1024
  };
}

function cpuPercentBetween(
  previous: WslKernelSnapshot,
  current: WslKernelSnapshot
): number | null {
  const totalDelta = current.totalTicks - previous.totalTicks;
  const busyDelta = current.busyTicks - previous.busyTicks;
  if (totalDelta <= 0 || busyDelta < 0) return null;
  return round(Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100)), 1);
}

function meminfoValue(raw: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'mu').exec(raw);
  return match?.[1] ? Number(match[1]) : null;
}

function probeWslKernel(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      ['--system', '--', 'sh', '-lc', 'cat /proc/stat /proc/meminfo'],
      {
        cwd: process.env['USERPROFILE'] ?? os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      }
    );
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT) {
        stdout += chunk.toString('utf8').slice(0, MAX_PROBE_OUTPUT - stdout.length);
      }
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 && stdout.trim() ? stdout : null));
  });
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
