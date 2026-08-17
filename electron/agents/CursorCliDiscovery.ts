import { spawn } from 'node:child_process';
import type {
  AgentCliAvailability,
  AgentIntegrationHost,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { Session } from '@shared/types/sessions.js';
import { effectiveAgentProvider } from '@shared/types/sessions.js';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CursorCliDiscoveryOptions {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
}

export class CursorCliDiscovery {
  private readonly run: NonNullable<CursorCliDiscoveryOptions['run']>;

  constructor(options: CursorCliDiscoveryOptions = {}) {
    this.run = options.run ?? runVersionCommand;
  }

  async detect(
    host: Pick<AgentIntegrationHost, 'kind' | 'distro'>,
    configuredBinary?: string
  ): Promise<AgentCliAvailability> {
    const candidates = configuredBinary ? [configuredBinary] : ['agent', 'cursor-agent'];
    for (const binary of candidates) {
      const command = host.kind === 'wsl' ? 'wsl.exe' : binary;
      const args = host.kind === 'wsl'
        ? ['-d', host.distro ?? '', '--', binary, '--version']
        : ['--version'];
      const result = await this.run(command, args);
      if (result.exitCode !== 0) continue;
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return {
        available: true,
        binary,
        ...(parseCursorVersion(output) ? { version: parseCursorVersion(output) } : {})
      };
    }
    return {
      available: false,
      reason: configuredBinary
        ? `Cursor Agent CLI is unavailable at ${configuredBinary}`
        : 'Cursor Agent CLI is unavailable (tried agent and cursor-agent)'
    };
  }
}

export async function enrichCursorCliStatus(
  status: AgentIntegrationStatus,
  configuredBinary: string | undefined,
  discovery: Pick<CursorCliDiscovery, 'detect'>
): Promise<AgentIntegrationStatus> {
  await Promise.all(status.hosts.map(async (entry) => {
    if (!entry.host.available) return;
    entry.cursor ??= { installed: false, current: false };
    entry.cursor.cli = await discovery.detect(entry.host, configuredBinary);
  }));
  return status;
}

export async function resolveCursorSessionBinaries(
  session: Session,
  binaries: SettingsBinaries | undefined,
  discovery: Pick<CursorCliDiscovery, 'detect'>
): Promise<SettingsBinaries | undefined> {
  if (effectiveAgentProvider(session) !== 'cursor' || binaries?.cursor) return binaries;
  if (session.runMode === 'wsl' && !session.wslDistro) return binaries;
  const host = session.runMode === 'wsl'
    ? { kind: 'wsl' as const, distro: session.wslDistro }
    : { kind: session.runMode };
  const cli = await discovery.detect(host);
  if (!cli.available || !cli.binary) {
    throw new Error(cli.reason ?? 'Cursor Agent CLI is unavailable');
  }
  return { ...binaries, cursor: cli.binary };
}

export function parseCursorVersion(output: string): string | undefined {
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  if (!line) return undefined;
  return line.replace(/^(?:cursor-agent|agent)\s+/iu, '').trim() || undefined;
}

async function runVersionCommand(executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
