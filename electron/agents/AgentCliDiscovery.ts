import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentCliAvailability,
  AgentIntegrationHost,
  AgentIntegrationHostStatus,
  AgentIntegrationStatus,
  AgentIntegrationTargetStatus
} from '@shared/types/ipc.js';
import type { SettingsBinaries } from '@shared/types/settings.js';

export type AgentCliProvider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'grok' | 'antigravity';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AgentCliDiscoveryOptions {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
}

const PROVIDER_SPECS = {
  claude: {
    label: 'Claude CLI',
    defaultBinaries: ['claude'] as const,
    configuredKey: 'claude' as const satisfies keyof SettingsBinaries,
    parseVersion: parseGenericVersion
  },
  codex: {
    label: 'Codex CLI',
    defaultBinaries: ['codex'] as const,
    configuredKey: 'codex' as const satisfies keyof SettingsBinaries,
    parseVersion: parseGenericVersion
  },
  cursor: {
    label: 'Cursor Agent CLI',
    defaultBinaries: ['agent', 'cursor-agent'] as const,
    configuredKey: 'cursor' as const satisfies keyof SettingsBinaries,
    parseVersion: parseCursorVersion
  },
  opencode: {
    label: 'OpenCode CLI',
    defaultBinaries: ['opencode'] as const,
    configuredKey: 'opencode' as const satisfies keyof SettingsBinaries,
    parseVersion: parseGenericVersion
  },
  grok: {
    label: 'Grok Build CLI',
    defaultBinaries: ['grok'] as const,
    configuredKey: 'grok' as const satisfies keyof SettingsBinaries,
    parseVersion: parseGenericVersion
  },
  antigravity: {
    label: 'Antigravity CLI',
    defaultBinaries: ['agy', 'antigravity'] as const,
    configuredKey: 'antigravity' as const satisfies keyof SettingsBinaries,
    parseVersion: parseGenericVersion
  }
} as const;

export class AgentCliDiscovery {
  private readonly run: NonNullable<AgentCliDiscoveryOptions['run']>;

  constructor(options: AgentCliDiscoveryOptions = {}) {
    this.run = options.run ?? runVersionCommand;
  }

  async detect(
    provider: AgentCliProvider,
    host: Pick<AgentIntegrationHost, 'kind' | 'distro'>,
    configuredBinary?: string
  ): Promise<AgentCliAvailability> {
    const spec = PROVIDER_SPECS[provider];
    const candidates = configuredBinary ? [configuredBinary] : [...spec.defaultBinaries];
    for (const binary of candidates) {
      const command = host.kind === 'wsl' ? 'wsl.exe' : binary;
      const args = host.kind === 'wsl'
        ? ['-d', host.distro ?? '', '--', binary, '--version']
        : ['--version'];
      const result = await this.run(command, args);
      if (result.exitCode !== 0) continue;
      const output = `${result.stdout}\n${result.stderr}`.trim();
      const version = spec.parseVersion(output);
      return {
        available: true,
        binary,
        ...(version ? { version } : {})
      };
    }
    return {
      available: false,
      reason: configuredBinary
        ? `${spec.label} is unavailable at ${configuredBinary}`
        : `${spec.label} is unavailable (tried ${candidates.join(' and ')})`
    };
  }
}

export async function enrichAgentCliStatus(
  status: AgentIntegrationStatus,
  binaries: SettingsBinaries | undefined,
  discovery: Pick<AgentCliDiscovery, 'detect'>
): Promise<AgentIntegrationStatus> {
  await Promise.all(status.hosts.map(async (entry) => {
    if (!entry.host.available) return;
    await Promise.all((Object.keys(PROVIDER_SPECS) as AgentCliProvider[]).map(async (provider) => {
      const target = ensureTarget(entry, provider);
      const configured = binaries?.[PROVIDER_SPECS[provider].configuredKey];
      target.cli = await discovery.detect(provider, entry.host, configured);
    }));
  }));
  return status;
}

function ensureTarget(
  entry: AgentIntegrationHostStatus,
  provider: AgentCliProvider
): AgentIntegrationTargetStatus {
  const current = entry[provider];
  if (current) return current;
  const created: AgentIntegrationTargetStatus = { installed: false, current: false };
  entry[provider] = created;
  return created;
}

export function parseCursorVersion(output: string): string | undefined {
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  if (!line) return undefined;
  return line.replace(/^(?:cursor-agent|agent)\s+/iu, '').trim() || undefined;
}

function parseGenericVersion(output: string): string | undefined {
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  if (!line) return undefined;
  const match = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/u);
  return match?.[0] ?? line;
}

function buildDiscoveryEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.pnpm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.fnm', 'current', 'bin'),
    '/snap/bin'
  ];
  const currentPath = process.env.PATH ?? '';
  const mergedPath = [...extraPaths, currentPath].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH: mergedPath };
}

async function runVersionCommand(executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildDiscoveryEnv()
    });
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
