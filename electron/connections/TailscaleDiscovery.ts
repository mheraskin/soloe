import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  runTailscaleCommand,
  TailscaleServeManager,
  type TailscaleServeStatus
} from '@soloe/domain';

export interface TailscaleDevice {
  name: string;
  dnsName: string;
  online: boolean;
  isSelf: boolean;
  ipAddress: string | null;
  os?: string;
}

export interface TailscaleNetworkResult {
  state: 'connected' | 'not-running' | 'unavailable' | 'error';
  tailnet: string | null;
  selfDnsName: string | null;
  selfIpAddress: string | null;
  message: string | null;
  devices: TailscaleDevice[];
}

export interface TailscaleDiscoveryResult extends TailscaleNetworkResult {
  sharing: TailscaleServeStatus;
}

type StatusRunner = () => Promise<string>;
type SharingRunner = (httpsPort: number) => Promise<TailscaleServeStatus>;

export class TailscaleDiscovery {
  constructor(
    private readonly runStatus: StatusRunner = runTailscaleStatus,
    private readonly ensureSharing: SharingRunner = (httpsPort) =>
      createServeManager(httpsPort).ensure()
  ) {}

  async discover(
    httpsPort = validEnvironmentPort(
      process.env.SOLOE_TAILSCALE_SERVE_PORT,
      DEFAULT_TAILSCALE_HTTPS_PORT,
    )
  ): Promise<TailscaleDiscoveryResult> {
    try {
      const network = parseTailscaleStatus(await this.runStatus());
      return {
        ...network,
        sharing: network.state === 'connected'
          ? await this.ensureSharing(validPort(httpsPort))
          : sharingForNetwork(network)
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          state: 'unavailable',
          tailnet: null,
          selfDnsName: null,
          selfIpAddress: null,
          message: 'Tailscale CLI was not found. Install Tailscale or set SOLOE_TAILSCALE_CLI.',
          devices: [],
          sharing: {
            state: 'unavailable',
            message: 'Install Tailscale to connect this Soloe Device to other machines.',
            setupUrl: 'https://tailscale.com/download'
          }
        };
      }
      return {
        state: 'error',
        tailnet: null,
        selfDnsName: null,
        selfIpAddress: null,
        message: error instanceof Error ? error.message : String(error),
        devices: [],
        sharing: {
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
          setupUrl: null
        }
      };
    }
  }
}

export function parseTailscaleStatus(raw: string): TailscaleNetworkResult {
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
      selfIpAddress: null,
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
    selfIpAddress: self?.ipAddress ?? null,
    message: null,
    devices: [...(self ? [self] : []), ...peers]
  };
}

function createServeManager(httpsPort: number): TailscaleServeManager {
  const localPort = validEnvironmentPort(process.env.SOLOE_WEB_PORT, 4318);
  return new TailscaleServeManager({
    targetUrl: localTailscaleServeTarget(`http://127.0.0.1:${localPort}`),
    httpsPort
  });
}

function localTailscaleServeTarget(webTarget: string): string {
  if (process.env.SOLOE_SUPERVISED_UI !== '1') return webTarget;
  const serverUrl = process.env.SOLOE_CLIENT_SERVER_URL?.trim();
  if (!serverUrl) return webTarget;
  try {
    const parsed = new URL(serverUrl);
    if (
      parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    ) {
      return webTarget;
    }
    return parsed.origin;
  } catch {
    return webTarget;
  }
}

function sharingForNetwork(network: TailscaleNetworkResult): TailscaleServeStatus {
  if (network.state === 'unavailable') {
    return {
      state: 'unavailable',
      message: 'Install Tailscale to connect this Soloe Device to other machines.',
      setupUrl: 'https://tailscale.com/download'
    };
  }
  if (network.state === 'not-running') {
    return {
      state: 'not-running',
      message: 'Open Tailscale and sign in to connect Soloe Devices.',
      setupUrl: null
    };
  }
  return {
    state: 'error',
    message: network.message,
    setupUrl: null
  };
}

function validEnvironmentPort(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : fallback;
}

function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Tailscale Serve port must be between 1 and 65535.');
  }
  return port;
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
  return runTailscaleCommand(['status', '--json']);
}

function deviceFromStatus(value: unknown, isSelf: boolean): TailscaleDevice | null {
  if (!isRecord(value)) return null;
  const dnsName = normalizeTailscaleDnsName(stringValue(value['DNSName']) ?? '');
  if (!dnsName) return null;
  const hostname = stringValue(value['HostName'])?.trim();
  const os = stringValue(value['OS'])?.trim();
  const ipAddress = tailscaleIpv4(value['TailscaleIPs']);
  return {
    name: hostname || dnsName.split('.')[0] || dnsName,
    dnsName,
    online: isSelf || value['Online'] === true,
    isSelf,
    ipAddress,
    ...(os ? { os } : {})
  };
}

function tailscaleIpv4(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value.find((entry): entry is string => typeof entry === 'string' && entry.startsWith('100.')) ?? null;
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
