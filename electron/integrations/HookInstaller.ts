import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { AgentIntegrationTargetStatus } from '@shared/types/ipc.js';
import { WslHostDetector, type WslDistroInfo } from './WslHostDetector.js';

export type HookHostKind = 'windows' | 'wsl';

export interface HookHost {
  kind: HookHostKind;
  distro?: string;
  label: string;
  homeDir: string;
  available: boolean;
  reason?: string;
}

export type HookHostKey =
  | { kind: 'windows' }
  | { kind: 'wsl'; distro: string };

export interface HostInstallStatus {
  host: HookHost;
  claude: AgentIntegrationTargetStatus;
  codex: AgentIntegrationTargetStatus;
}

export interface HookInstallStatus {
  hosts: HostInstallStatus[];
}

export interface HookInstallerOptions {
  hosts?: HookHost[];
  detector?: WslHostDetector;
}

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PreCompact',
  'SubagentStop'
];

const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop'
];

const SOLOE_MARKER = '_soloe';
const SOLOE_VERSION_KEY = '_soloe_version';
export const SOLOE_HOOK_VERSION = 9;
const HOOK_COMMAND_CLAUDE = buildHookCommand('claude');
const HOOK_COMMAND_CODEX = buildHookCommand('codex');

function buildHookCommand(provider: 'claude' | 'codex'): string {
  const endpoint = provider === 'claude' ? '/hook/claude' : '/hook/codex';
  // POSIX sh: bail if no bridge URL; if URL points at host.wsl.internal and that
  // doesn't resolve (NAT-mode WSL2), swap the host for the WSL→Windows gateway
  // IP (or /etc/resolv.conf nameserver as fallback); then POST the payload.
  const wslResolve =
    'case "$u" in *host.wsl.internal*) ' +
    'getent hosts host.wsl.internal >/dev/null 2>&1 || ' +
    '{ ' +
    "h=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}'); " +
    "[ -z \"$h\" ] && h=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null); " +
    '[ -n "$h" ] && u=$(printf \'%s\' "$u" | sed "s|host\\.wsl\\.internal|$h|"); ' +
    '} ;; esac';
  const curl =
    'curl -sS --max-time 1 -X POST ' +
    '-H "Authorization: Bearer $SOLOE_BRIDGE_TOKEN" ' +
    '-H "X-Soloe-Session-Id: $SOLOE_SESSION_ID" ' +
    '-H "Content-Type: application/json" ' +
    `--data-binary @- "$u${endpoint}" >/dev/null 2>&1 || true`;
  // When running outside Soloe (no bridge URL), drain stdin before exiting —
  // otherwise codex/claude pipes the hook payload into a closed stdin and
  // reports "failed to write hook stdin: Broken pipe (os error 32)".
  return `[ -z "$SOLOE_BRIDGE_URL" ] && { cat >/dev/null 2>&1; exit 0; }; u="$SOLOE_BRIDGE_URL"; ${wslResolve}; ${curl}`;
}

export function defaultLocalHost(): HookHost {
  return {
    kind: 'windows',
    label: process.platform === 'win32' ? 'Windows' : 'Local',
    homeDir: os.homedir(),
    available: true
  };
}

export function wslHostFrom(info: WslDistroInfo): HookHost {
  if (!info.available || !info.homeUnc) {
    return {
      kind: 'wsl',
      distro: info.distro,
      label: `WSL: ${info.distro}`,
      homeDir: '',
      available: false,
      reason: info.reason ?? 'distro unavailable'
    };
  }
  return {
    kind: 'wsl',
    distro: info.distro,
    label: `WSL: ${info.distro}`,
    homeDir: info.homeUnc,
    available: true
  };
}

export class HookInstaller {
  private hostsList: HookHost[];
  private readonly detector: WslHostDetector;

  constructor(opts: HookInstallerOptions = {}) {
    this.hostsList = opts.hosts ?? [defaultLocalHost()];
    this.detector = opts.detector ?? new WslHostDetector();
  }

  hosts(): HookHost[] {
    return [...this.hostsList];
  }

  async refresh(): Promise<void> {
    const wslInfos = await this.detector.detect();
    this.hostsList = [defaultLocalHost(), ...wslInfos.map(wslHostFrom)];
  }

  async status(): Promise<HookInstallStatus> {
    const hosts = await Promise.all(
      this.hostsList.map(async (host) => {
        if (!host.available) {
          return {
            host,
            claude: emptyStatus(),
            codex: emptyStatus()
          };
        }
        const [claude, codex] = await Promise.all([
          this.claudeFileSoloeStatus(this.claudeUserPath(host)),
          this.codexFileSoloeStatus(this.codexConfigPath(host))
        ]);
        return { host, claude, codex };
      })
    );
    return { hosts };
  }

  async installClaude(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.claudeUserPath(target);
    const original = await readJsonOrNull(filePath);
    const updated = mergeClaudeHooks(original ?? {}, HOOK_COMMAND_CLAUDE);
    await this.writeAtomic(filePath, JSON.stringify(updated, null, 2) + '\n', original !== null);
  }

  async uninstallClaude(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.claudeUserPath(target);
    const original = await readJsonOrNull(filePath);
    if (!original) return;
    const cleaned = removeSoloeFromClaude(original);
    await this.writeAtomic(filePath, JSON.stringify(cleaned, null, 2) + '\n', false);
  }

  async installCodex(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.codexConfigPath(target);
    const original = await readTomlOrNull(filePath);
    const updated = mergeCodexHooks(original ?? {}, HOOK_COMMAND_CODEX);
    await this.writeAtomic(filePath, stringifyToml(updated), original !== null);
  }

  async uninstallCodex(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.codexConfigPath(target);
    const original = await readTomlOrNull(filePath);
    if (!original) return;
    const cleaned = removeSoloeFromCodex(original);
    await this.writeAtomic(filePath, stringifyToml(cleaned), false);
  }

  private requireHost(key: HookHostKey): HookHost {
    const host = this.hostsList.find((h) =>
      h.kind === key.kind && (key.kind === 'windows' || h.distro === key.distro)
    );
    if (!host) throw new Error(`Unknown host: ${describeHostKey(key)}`);
    if (!host.available) {
      throw new Error(`Host is unavailable: ${host.label}${host.reason ? ` (${host.reason})` : ''}`);
    }
    return host;
  }

  private claudeUserPath(host: HookHost): string {
    return path.join(host.homeDir, '.claude', 'settings.json');
  }

  private codexConfigPath(host: HookHost): string {
    return path.join(host.homeDir, '.codex', 'config.toml');
  }

  private async claudeFileSoloeStatus(filePath: string): Promise<AgentIntegrationTargetStatus> {
    const data = await readJsonOrNull(filePath);
    if (!data) return emptyStatus();
    return claudeSoloeStatus(data);
  }

  private async codexFileSoloeStatus(filePath: string): Promise<AgentIntegrationTargetStatus> {
    const data = await readTomlOrNull(filePath);
    if (!data) return emptyStatus();
    return codexSoloeStatus(data);
  }

  private async writeAtomic(filePath: string, content: string, backup: boolean): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (backup) {
      try {
        const existing = await fs.readFile(filePath, 'utf8');
        const backupPath = `${filePath}.soloe-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          await fs.access(backupPath);
        } catch {
          await fs.writeFile(backupPath, existing, 'utf8');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  }
}

function describeHostKey(key: HookHostKey): string {
  return key.kind === 'wsl' ? `wsl:${key.distro}` : 'windows';
}

async function readJsonOrNull(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readTomlOrNull(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = parseToml(raw);
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function mergeClaudeHooks(
  original: Record<string, unknown>,
  command: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const hooksRoot = isObject(next['hooks']) ? { ...next['hooks'] } : {};
  for (const event of CLAUDE_EVENTS) {
    const groups = Array.isArray(hooksRoot[event]) ? [...(hooksRoot[event] as unknown[])] : [];
    const filtered = groups.filter((entry) => !isSoloeClaudeEntry(entry));
    filtered.push({
      [SOLOE_MARKER]: true,
      [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION,
      hooks: [
        {
          type: 'command',
          command,
          [SOLOE_MARKER]: true,
          [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION
        }
      ]
    });
    hooksRoot[event] = filtered;
  }
  next['hooks'] = hooksRoot;
  return next;
}

export function removeSoloeFromClaude(
  original: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  if (!isObject(next['hooks'])) return next;
  const hooksRoot: Record<string, unknown> = { ...next['hooks'] };
  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((group) => stripSoloeFromGroup(group))
      .filter((group) => group !== null);
    if (cleaned.length === 0) {
      delete hooksRoot[event];
    } else {
      hooksRoot[event] = cleaned;
    }
  }
  if (Object.keys(hooksRoot).length === 0) {
    delete next['hooks'];
  } else {
    next['hooks'] = hooksRoot;
  }
  return next;
}

export function mergeCodexHooks(
  original: Record<string, unknown>,
  command: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const features = isObject(next['features']) ? { ...next['features'] } : {};
  features['codex_hooks'] = true;
  next['features'] = features;
  const hooksRoot = isObject(next['hooks']) ? { ...next['hooks'] } : {};
  for (const event of CODEX_EVENTS) {
    const groups = Array.isArray(hooksRoot[event]) ? [...(hooksRoot[event] as unknown[])] : [];
    const filtered = groups.filter((entry) => !isSoloeCodexEntry(entry));
    filtered.push({
      [SOLOE_MARKER]: true,
      [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION,
      hooks: [
        {
          type: 'command',
          command,
          [SOLOE_MARKER]: true,
          [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION
        }
      ]
    });
    hooksRoot[event] = filtered;
  }
  next['hooks'] = hooksRoot;
  return next;
}

export function removeSoloeFromCodex(
  original: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  if (!isObject(next['hooks'])) return next;
  const hooksRoot: Record<string, unknown> = { ...next['hooks'] };
  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((group) => stripSoloeFromGroup(group))
      .filter((group) => group !== null);
    if (cleaned.length === 0) {
      delete hooksRoot[event];
    } else {
      hooksRoot[event] = cleaned;
    }
  }
  if (Object.keys(hooksRoot).length === 0) {
    delete next['hooks'];
  } else {
    next['hooks'] = hooksRoot;
  }
  return next;
}

function claudeSoloeStatus(data: Record<string, unknown>): AgentIntegrationTargetStatus {
  const hooks = data['hooks'];
  if (!isObject(hooks)) return emptyStatus();
  const versions: number[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const version = soloeClaudeEntryVersion(group);
      if (version !== null) versions.push(version);
    }
  }
  return statusFromVersions(versions);
}

function codexSoloeStatus(data: Record<string, unknown>): AgentIntegrationTargetStatus {
  const hooks = data['hooks'];
  if (!isObject(hooks)) return emptyStatus();
  const versions: number[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const version = soloeCodexEntryVersion(group);
      if (version !== null) versions.push(version);
    }
  }
  return statusFromVersions(versions);
}

function isSoloeClaudeEntry(entry: unknown): boolean {
  return soloeClaudeEntryVersion(entry) !== null;
}

function soloeClaudeEntryVersion(entry: unknown): number | null {
  if (!isObject(entry)) return null;
  if (entry[SOLOE_MARKER] === true) return markerVersion(entry);
  const inner = entry['hooks'];
  if (!Array.isArray(inner)) return null;
  for (const h of inner) {
    if (isObject(h) && h[SOLOE_MARKER] === true) return markerVersion(h);
  }
  return null;
}

function isSoloeCodexEntry(entry: unknown): boolean {
  return soloeCodexEntryVersion(entry) !== null;
}

function soloeCodexEntryVersion(entry: unknown): number | null {
  if (!isObject(entry)) return null;
  if (entry[SOLOE_MARKER] === true) return markerVersion(entry);
  const inner = entry['hooks'];
  if (!Array.isArray(inner)) return null;
  for (const h of inner) {
    if (isObject(h) && h[SOLOE_MARKER] === true) return markerVersion(h);
  }
  return null;
}

function markerVersion(entry: Record<string, unknown>): number {
  return typeof entry[SOLOE_VERSION_KEY] === 'number' ? entry[SOLOE_VERSION_KEY] : 1;
}

function emptyStatus(): AgentIntegrationTargetStatus {
  return { installed: false, current: false };
}

function statusFromVersions(versions: number[]): AgentIntegrationTargetStatus {
  if (versions.length === 0) return emptyStatus();
  const newest = Math.max(...versions);
  return {
    installed: true,
    current: versions.some((version) => version === SOLOE_HOOK_VERSION),
    version: newest
  };
}

function stripSoloeFromGroup(group: unknown): unknown | null {
  if (!isObject(group)) return group;
  if (group[SOLOE_MARKER] === true) return null;
  const inner = group['hooks'];
  if (!Array.isArray(inner)) return group;
  const cleaned = inner.filter((h) => !(isObject(h) && h[SOLOE_MARKER] === true));
  if (cleaned.length === 0) return null;
  return { ...group, hooks: cleaned };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
