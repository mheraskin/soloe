import type {
  AgentCliAvailability,
  AgentIntegrationHost,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { Session } from '@shared/types/sessions.js';
import { effectiveAgentProvider } from '@shared/types/sessions.js';
import {
  AgentCliDiscovery,
  enrichAgentCliStatus,
  parseCursorVersion
} from './AgentCliDiscovery.js';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CursorCliDiscoveryOptions {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
}

export class CursorCliDiscovery {
  private readonly discovery: AgentCliDiscovery;

  constructor(options: CursorCliDiscoveryOptions = {}) {
    this.discovery = new AgentCliDiscovery(options.run ? { run: options.run } : {});
  }

  detect(
    host: Pick<AgentIntegrationHost, 'kind' | 'distro'>,
    configuredBinary?: string
  ): Promise<AgentCliAvailability> {
    return this.discovery.detect('cursor', host, configuredBinary);
  }
}

/** @deprecated Prefer enrichAgentCliStatus — kept for Cursor-focused call sites/tests. */
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

export { parseCursorVersion, enrichAgentCliStatus, AgentCliDiscovery };
