import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TailscaleDevice {
  name: string;
  dnsName: string;
  online: boolean;
  isSelf: boolean;
  os?: string;
}

export interface TailscaleDiscoveryResult {
  state: 'connected' | 'not-running' | 'unavailable' | 'error';
  tailnet: string | null;
  selfDnsName: string | null;
  message: string | null;
  devices: TailscaleDevice[];
}

type StatusRunner = () => Promise<string>;

export class TailscaleDiscovery {
  constructor(private readonly runStatus: StatusRunner = runTailscaleStatus) {}

  async discover(): Promise<TailscaleDiscoveryResult> {
    try {
      return parseTailscaleStatus(await this.runStatus());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          state: 'unavailable',
          tailnet: null,
          selfDnsName: null,
          message: 'Tailscale CLI was not found. Install Tailscale or set SOLOE_TAILSCALE_CLI.',
          devices: []
        };
      }
      return {
        state: 'error',
        tailnet: null,
        selfDnsName: null,
        message: error instanceof Error ? error.message : String(error),
        devices: []
      };
    }
  }
}

export function parseTailscaleStatus(raw: string): TailscaleDiscoveryResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Tailscale status JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error('Invalid Tailscale status JSON: expected an object');

  const backendState = stringValue(value['BackendState']);
  if (backendState && backendState !== 'Running') {
    return {
      state: 'not-running',
      tailnet: tailnetName(value),
      selfDnsName: null,
      message: `Tailscale is ${backendState.toLowerCase()}.`,
      devices: []
    };
  }

  const self = deviceFromStatus(value['Self'], true);
  const peers = isRecord(value['Peer'])
    ? Object.values(value['Peer'])
        .map((peer) => deviceFromStatus(peer, false))
        .filter((peer): peer is TailscaleDevice => peer !== null)
    : [];

  return {
    state: 'connected',
    tailnet: tailnetName(value),
    selfDnsName: self?.dnsName ?? null,
    message: null,
    devices: [...(self ? [self] : []), ...peers]
  };
}

export function normalizeTailscaleDnsName(value: string): string | null {
  const hostname = value.trim().replace(/\.$/u, '').toLowerCase();
  if (
    hostname.length === 0
    || hostname.length > 253
    || !hostname.endsWith('.ts.net')
    || hostname.split('.').length < 4
  ) {
    return null;
  }
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    return null;
  }
  return hostname;
}

async function runTailscaleStatus(): Promise<string> {
  const executable = process.env.SOLOE_TAILSCALE_CLI?.trim() || 'tailscale';
  const { stdout } = await execFileAsync(executable, ['status', '--json'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4 * 1_024 * 1_024,
    windowsHide: true
  });
  return stdout;
}

function deviceFromStatus(value: unknown, isSelf: boolean): TailscaleDevice | null {
  if (!isRecord(value)) return null;
  const dnsName = normalizeTailscaleDnsName(stringValue(value['DNSName']) ?? '');
  if (!dnsName) return null;
  const hostname = stringValue(value['HostName'])?.trim();
  const os = stringValue(value['OS'])?.trim();
  return {
    name: hostname || dnsName.split('.')[0] || dnsName,
    dnsName,
    online: isSelf || value['Online'] === true,
    isSelf,
    ...(os ? { os } : {})
  };
}

function tailnetName(status: Record<string, unknown>): string | null {
  const currentTailnet = status['CurrentTailnet'];
  if (!isRecord(currentTailnet)) return null;
  return stringValue(currentTailnet['Name'])?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
