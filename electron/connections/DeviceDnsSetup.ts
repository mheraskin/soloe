import { promises as dns } from 'node:dns';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ShortDnsInfo } from '@shared/types/connections.js';

const execFileAsync = promisify(execFile);
const DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';
const DNS_CHECK_TIMEOUT_MS = 1_200;

export interface DeviceDnsIdentity {
  enabled: boolean;
  connected: boolean;
  selfDnsName: string | null;
  selfIpAddress: string | null;
}

export interface DeviceDnsSetupOptions {
  helperPath: string;
  platform?: NodeJS.Platform;
  resolveDirect?: (hostname: string, nameserver: string) => Promise<string[]>;
  resolveSystem?: (hostname: string) => Promise<string[]>;
  install?: (request: DeviceDnsInstallRequest) => Promise<void>;
  remove?: () => Promise<void>;
}

export interface DeviceDnsInstallRequest {
  helperPath: string;
  zone: string;
  nameserver: string;
}

export interface DeviceDnsZone {
  zone: string;
  nameserver: string;
}

export class DeviceDnsSetup {
  private identity: DeviceDnsIdentity = {
    enabled: false,
    connected: false,
    selfDnsName: null,
    selfIpAddress: null
  };

  constructor(private readonly options: DeviceDnsSetupOptions) {}

  async status(identity: DeviceDnsIdentity): Promise<ShortDnsInfo> {
    this.identity = { ...identity };
    if (!identity.enabled) return disabledStatus();
    if (!identity.connected) {
      return {
        state: 'unavailable',
        zone: null,
        nameserver: null,
        message: 'Connect Tailscale before setting up short Device URLs.',
        setupUrl: null,
        readyZones: []
      };
    }
    const zone = deviceZone(identity.selfDnsName);
    const nameserver = validTailscaleIpv4(identity.selfIpAddress);
    if (!zone || !nameserver) {
      return {
        state: 'error',
        zone,
        nameserver,
        message: 'Tailscale did not report a usable Device name and IPv4 address.',
        setupUrl: null,
        readyZones: []
      };
    }
    const probe = `soloe-dns-check.${zone}`;
    const direct = await withTimeout(this.options.resolveDirect
      ? this.options.resolveDirect(probe, nameserver)
      : resolveDirect(probe, nameserver), DNS_CHECK_TIMEOUT_MS).catch((): string[] => []);
    if (!direct.includes(nameserver)) {
      return {
        state: 'setup-required',
        zone,
        nameserver,
        message: `Install Soloe DNS on this Device to serve ${zone} and *.${zone}.`,
        setupUrl: null,
        readyZones: []
      };
    }
    const routed = await withTimeout(this.options.resolveSystem
      ? this.options.resolveSystem(probe)
      : resolveSystem(probe), DNS_CHECK_TIMEOUT_MS).catch((): string[] => []);
    if (!routed.includes(nameserver)) {
      return {
        state: 'route-required',
        zone,
        nameserver,
        message: `Soloe DNS is running. Add a restricted nameserver for ${zone} pointing to ${nameserver} in Tailscale DNS.`,
        setupUrl: DNS_ADMIN_URL,
        readyZones: []
      };
    }
    return {
      state: 'ready',
      zone,
      nameserver,
      message: `${zone} and *.${zone} resolve to this Device across the tailnet.`,
      setupUrl: DNS_ADMIN_URL,
      readyZones: [zone]
    };
  }

  async resolvedZones(zones: DeviceDnsZone[]): Promise<string[]> {
    const results = await Promise.all(zones.slice(0, 16).map(async ({ zone, nameserver }) => {
      if (deviceZone(`${zone}.invalid`) !== zone || !validTailscaleIpv4(nameserver)) return null;
      const probe = `soloe-dns-check.${zone}`;
      const resolved = await withTimeout(this.options.resolveSystem
        ? this.options.resolveSystem(probe)
        : resolveSystem(probe), DNS_CHECK_TIMEOUT_MS).catch((): string[] => []);
      return resolved.includes(nameserver) ? zone : null;
    }));
    return [...new Set(results.filter((zone): zone is string => zone !== null))];
  }

  async setup(): Promise<ShortDnsInfo> {
    const current = await this.status(this.identity);
    if (current.state !== 'setup-required') return current;
    if (!current.zone || !current.nameserver) return current;
    const install = this.options.install ?? ((request) => installDeviceDns(request, this.options.platform));
    await install({
      helperPath: this.options.helperPath,
      zone: current.zone,
      nameserver: current.nameserver
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = await this.status(this.identity);
      if (next.state !== 'setup-required') return next;
      await delay(200);
    }
    return this.status(this.identity);
  }

  async remove(): Promise<ShortDnsInfo> {
    const current = await this.status(this.identity);
    if (current.state === 'setup-required') return current;
    if (current.state === 'ready') {
      throw new Error(`Remove the restricted DNS route for ${current.zone} in Tailscale before uninstalling Soloe DNS.`);
    }
    if (current.state !== 'route-required') {
      throw new Error(current.message ?? 'Soloe DNS cannot be removed in its current state.');
    }
    const remove = this.options.remove ?? (() => removeDeviceDns(this.options.platform));
    await remove();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const next = await this.status(this.identity);
      if (next.state === 'setup-required') return next;
      await delay(200);
    }
    const final = await this.status(this.identity);
    if (final.state !== 'setup-required') {
      throw new Error('Soloe DNS is still running after the uninstall command completed.');
    }
    return final;
  }
}

export function resolveDeviceDnsHelperPath(
  resourcesPath: string | null = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null
): string {
  const configured = process.env.SOLOE_DEVICE_DNS_HELPER?.trim();
  if (configured) return path.resolve(configured);
  const executable = process.platform === 'win32' ? 'soloe-device-dns.exe' : 'soloe-device-dns';
  return resourcesPath
    ? path.join(resourcesPath, 'bin', executable)
    : path.join(process.cwd(), 'target', 'release', executable);
}

export function deviceZone(selfDnsName: string | null): string | null {
  const label = selfDnsName?.trim().toLowerCase().split('.')[0] ?? '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) ? label : null;
}

export function validTailscaleIpv4(value: string | null): string | null {
  if (!value?.startsWith('100.')) return null;
  const octets = value.split('.').map(Number);
  return octets.length === 4
    && octets[1] !== undefined
    && octets[1] >= 64
    && octets[1] <= 127
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? value
    : null;
}

async function resolveDirect(hostname: string, nameserver: string): Promise<string[]> {
  const resolver = new dns.Resolver();
  resolver.setServers([nameserver]);
  return resolver.resolve4(hostname);
}

async function resolveSystem(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { family: 4, all: true });
  return results.map((result) => result.address);
}

async function installDeviceDns(
  request: DeviceDnsInstallRequest,
  platform = process.platform
): Promise<void> {
  await fs.access(request.helperPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-device-dns-'));
  try {
    if (platform === 'darwin') await installMacos(request, temporaryDirectory);
    else if (platform === 'linux') await installLinux(request, temporaryDirectory);
    else if (platform === 'win32') await installWindows(request, temporaryDirectory);
    else throw new Error(`Soloe DNS setup is not supported on ${platform}.`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function removeDeviceDns(platform = process.platform): Promise<void> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-device-dns-remove-'));
  try {
    if (platform === 'darwin') await removeMacos();
    else if (platform === 'linux') await removeLinux(temporaryDirectory);
    else if (platform === 'win32') await removeWindows(temporaryDirectory);
    else throw new Error(`Soloe DNS removal is not supported on ${platform}.`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function installLinux(request: DeviceDnsInstallRequest, directory: string): Promise<void> {
  const service = `[Unit]\nDescription=Soloe Device DNS\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/local/libexec/soloe-device-dns --zone ${request.zone} --address ${request.nameserver}\nRestart=on-failure\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n`;
  const servicePath = path.join(directory, 'soloe-device-dns.service');
  const scriptPath = path.join(directory, 'install.sh');
  await fs.writeFile(servicePath, service, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(scriptPath, `#!/bin/sh\nset -eu\ninstall -d -m 0755 /usr/local/libexec\ninstall -m 0755 ${shellQuote(request.helperPath)} /usr/local/libexec/soloe-device-dns\ninstall -m 0644 ${shellQuote(servicePath)} /etc/systemd/system/soloe-device-dns.service\nsystemctl daemon-reload\nsystemctl enable --now soloe-device-dns.service\nsystemctl restart soloe-device-dns.service\n`, { encoding: 'utf8', mode: 0o700 });
  await execFileAsync('pkexec', [scriptPath]);
}

async function removeLinux(directory: string): Promise<void> {
  const scriptPath = path.join(directory, 'remove.sh');
  await fs.writeFile(scriptPath, linuxDeviceDnsRemovalScript(), { encoding: 'utf8', mode: 0o700 });
  await execFileAsync('pkexec', [scriptPath]);
}

async function installMacos(request: DeviceDnsInstallRequest, directory: string): Promise<void> {
  const label = 'com.soloe.device-dns';
  const destination = '/Library/Application Support/Soloe/soloe-device-dns';
  const plistPath = path.join(directory, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${destination}</string><string>--zone</string><string>${request.zone}</string><string>--address</string><string>${request.nameserver}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>/var/log/soloe-device-dns.log</string>\n<key>StandardErrorPath</key><string>/var/log/soloe-device-dns.log</string>\n</dict></plist>\n`;
  await fs.writeFile(plistPath, plist, { encoding: 'utf8', mode: 0o600 });
  const destinationPlist = `/Library/LaunchDaemons/${label}.plist`;
  const command = [
    `mkdir -p ${shellQuote(path.dirname(destination))}`,
    `install -m 0755 ${shellQuote(request.helperPath)} ${shellQuote(destination)}`,
    `install -m 0644 ${shellQuote(plistPath)} ${shellQuote(destinationPlist)}`,
    `(launchctl bootout system/${label} >/dev/null 2>&1 || true)`,
    `launchctl bootstrap system ${shellQuote(destinationPlist)}`
  ].join(' && ');
  await execFileAsync('osascript', ['-e', `do shell script ${appleScriptString(command)} with administrator privileges`]);
}

async function removeMacos(): Promise<void> {
  await execFileAsync('osascript', [
    '-e',
    `do shell script ${appleScriptString(macosDeviceDnsRemovalCommand())} with administrator privileges`
  ]);
}

async function installWindows(request: DeviceDnsInstallRequest, directory: string): Promise<void> {
  const scriptPath = path.join(directory, 'install.ps1');
  const source = powershellString(request.helperPath);
  const zone = powershellString(request.zone);
  const nameserver = powershellString(request.nameserver);
  const script = `$ErrorActionPreference = 'Stop'\n$directory = Join-Path $env:ProgramFiles 'Soloe'\n$destination = Join-Path $directory 'soloe-device-dns.exe'\nNew-Item -ItemType Directory -Force -Path $directory | Out-Null\nCopy-Item -Force -LiteralPath ${source} -Destination $destination\n& sc.exe stop SoloeDeviceDns 2>$null | Out-Null\n& sc.exe delete SoloeDeviceDns 2>$null | Out-Null\n$binaryPath = '\"' + $destination + '\" --zone ' + ${zone} + ' --address ' + ${nameserver}\n& sc.exe create SoloeDeviceDns start= auto binPath= $binaryPath | Out-Null\n& sc.exe start SoloeDeviceDns | Out-Null\n`;
  await fs.writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o600 });
  const elevated = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${powershellString(scriptPath)})`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', elevated]);
}

async function removeWindows(directory: string): Promise<void> {
  const scriptPath = path.join(directory, 'remove.ps1');
  await fs.writeFile(scriptPath, windowsDeviceDnsRemovalScript(), { encoding: 'utf8', mode: 0o600 });
  const elevated = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${powershellString(scriptPath)})`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', elevated]);
}

export function linuxDeviceDnsRemovalScript(): string {
  return `#!/bin/sh
set -eu
systemctl disable --now soloe-device-dns.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/soloe-device-dns.service
rm -f /usr/local/libexec/soloe-device-dns
systemctl daemon-reload
`;
}

export function macosDeviceDnsRemovalCommand(): string {
  const label = 'com.soloe.device-dns';
  const destination = '/Library/Application Support/Soloe/soloe-device-dns';
  const plist = `/Library/LaunchDaemons/${label}.plist`;
  return [
    `(launchctl bootout system/${label} >/dev/null 2>&1 || true)`,
    `rm -f ${shellQuote(plist)}`,
    `rm -f ${shellQuote(destination)}`,
    `rm -f /var/log/soloe-device-dns.log`,
    `(rmdir ${shellQuote(path.dirname(destination))} >/dev/null 2>&1 || true)`
  ].join(' && ');
}

export function windowsDeviceDnsRemovalScript(): string {
  return `$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:ProgramFiles 'Soloe'
$destination = Join-Path $directory 'soloe-device-dns.exe'
& sc.exe stop SoloeDeviceDns 2>$null | Out-Null
& sc.exe delete SoloeDeviceDns 2>$null | Out-Null
Remove-Item -Force -LiteralPath $destination -ErrorAction SilentlyContinue
Remove-Item -Force -LiteralPath $directory -ErrorAction SilentlyContinue
`;
}

function disabledStatus(): ShortDnsInfo {
  return {
    state: 'disabled',
    zone: null,
    nameserver: null,
    message: 'Enable Tailscale connections to use short Device URLs.',
    setupUrl: null,
    readyZones: []
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS check timed out.')), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
