import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type {
  AgentIntegrationHost,
  AgentIntegrationTargetStatus
} from '@shared/types/ipc.js';
import { WslHostDetector, type WslDistroInfo } from './WslHostDetector.js';
import { hostPlatform } from '@shared/platform.js';

export type HookHostKind = 'windows' | 'linux' | 'macos' | 'wsl';

export interface HookHost {
  kind: HookHostKind;
  distro?: string;
  label: string;
  homeDir: string;
  // For WSL hosts: the in-distro Linux home (e.g. /home/foo). Codex computes
  // hook-trust keys from the source path it itself reads — that's the Linux
  // path inside the distro, not the UNC we write through. Always set for
  // available WSL hosts.
  homeLinux?: string;
  available: boolean;
  reason?: string;
}

export type HookHostKey =
  | { kind: 'windows' }
  | { kind: 'linux' }
  | { kind: 'macos' }
  | { kind: 'wsl'; distro: string };

export interface HostInstallStatus {
  host: AgentIntegrationHost;
  claude: AgentIntegrationTargetStatus;
  codex: AgentIntegrationTargetStatus;
  cursor: AgentIntegrationTargetStatus;
}

export interface HookInstallStatus {
  hosts: HostInstallStatus[];
}

export interface BridgeIdentity {
  port: number;
  token: string;
}

export interface HookInstallerOptions {
  hosts?: HookHost[];
  detector?: WslHostDetector;
  bridge?: BridgeIdentity;
  // Resolves the hostname an MCP client inside `distro` should use to reach
  // the Windows host. Defaults to "host.wsl.internal"; override with a probe
  // (e.g. via wsl.exe ip route) for distros where that doesn't resolve.
  wslHostnameProbe?: (distro: string) => Promise<string>;
}

export interface RefreshMcpResult {
  // Hosts whose MCP URLs were rewritten because the resolved value changed.
  rewritten: HookHostKey[];
  errors: { host: HookHostKey; error: string }[];
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

// Codex's persisted-hook-state keys use lowercase snake_case event labels (see
// codex-rs/hooks/src/lib.rs::hook_event_key_label). PascalCase is only the
// TOML event-array key.
const CODEX_EVENT_LABEL: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop'
};

const SOLOE_MARKER = '_soloe';
const SOLOE_VERSION_KEY = '_soloe_version';
// Bumping forces a one-time reinstall on next boot. v14 migrates the Claude
// MCP entry from ~/.claude/settings.json (where it never actually loaded —
// Claude Code reads MCP servers from ~/.claude.json) to ~/.claude.json, and
// scrubs the stale settings.json entry as a side effect.
export const SOLOE_HOOK_VERSION = 14;
const SOLOE_MCP_NAME = 'soloe';
const SOLOE_BRIDGE_TOKEN_ENV = 'SOLOE_BRIDGE_TOKEN';
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

export function defaultLocalHost(nodePlatform?: string): HookHost {
  const kind = hostPlatform(nodePlatform);
  return {
    kind,
    label: kind === 'windows' ? 'Windows' : kind === 'macos' ? 'macOS' : 'Linux',
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
    homeLinux: info.homeLinux ?? undefined,
    available: true
  };
}

export class HookInstaller {
  private hostsList: HookHost[];
  private readonly detector: WslHostDetector;
  private readonly bridge: BridgeIdentity | null;
  private readonly wslHostnameProbe: (distro: string) => Promise<string>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(opts: HookInstallerOptions = {}) {
    this.hostsList = opts.hosts ?? [defaultLocalHost()];
    this.detector = opts.detector ?? new WslHostDetector();
    this.bridge = opts.bridge ?? null;
    this.wslHostnameProbe = opts.wslHostnameProbe ?? (async () => 'host.wsl.internal');
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
            host: publicHost(host),
            claude: emptyStatus(),
            codex: emptyStatus(),
            cursor: emptyStatus()
          };
        }
        const [claude, codex, cursor] = await Promise.all([
          this.claudeHostSoloeStatus(host),
          this.codexFileSoloeStatus(this.codexConfigPath(host)),
          this.cursorFileSoloeStatus(this.cursorConfigPath(host))
        ]);
        return { host: publicHost(host), claude, codex, cursor };
      })
    );
    return { hosts };
  }

  // Claude Code reads hooks from ~/.claude/settings.json but MCP servers from
  // ~/.claude.json (a separate file). Hooks land in settings.json; the soloe
  // MCP entry lands in claude.json. As a migration step we also scrub any
  // stale mcpServers.soloe left behind in settings.json by ≤v13.
  async installClaude(host: HookHostKey): Promise<void> {
    return this.serializeMutation(() => this.installClaudeNow(host));
  }

  private async installClaudeNow(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);

    const settingsPath = this.claudeUserPath(target);
    const settingsOriginal = await readJsonOrNull(settingsPath);
    let settingsUpdated = mergeClaudeHooks(settingsOriginal ?? {}, HOOK_COMMAND_CLAUDE);
    settingsUpdated = stripSoloeMcpEntry(settingsUpdated);
    await this.writeAtomic(
      settingsPath,
      JSON.stringify(settingsUpdated, null, 2) + '\n',
      settingsOriginal !== null
    );

    if (this.bridge) {
      const claudeJsonPath = this.claudeJsonPath(target);
      const claudeJsonOriginal = await readJsonOrNull(claudeJsonPath);
      const url = await this.resolveMcpUrlForHost(target);
      const claudeJsonUpdated = mergeClaudeMcp(claudeJsonOriginal ?? {}, {
        url,
        token: this.bridge.token
      });
      await this.writeAtomic(
        claudeJsonPath,
        JSON.stringify(claudeJsonUpdated, null, 2) + '\n',
        claudeJsonOriginal !== null
      );
    }
  }

  async uninstallClaude(host: HookHostKey): Promise<void> {
    return this.serializeMutation(() => this.uninstallClaudeNow(host));
  }

  private async uninstallClaudeNow(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);

    const settingsPath = this.claudeUserPath(target);
    const settingsOriginal = await readJsonOrNull(settingsPath);
    if (settingsOriginal) {
      const cleaned = removeSoloeFromClaude(settingsOriginal);
      await this.writeAtomic(settingsPath, JSON.stringify(cleaned, null, 2) + '\n', false);
    }

    const claudeJsonPath = this.claudeJsonPath(target);
    const claudeJsonOriginal = await readJsonOrNull(claudeJsonPath);
    if (claudeJsonOriginal) {
      const cleaned = removeSoloeFromClaude(claudeJsonOriginal);
      if (JSON.stringify(cleaned) !== JSON.stringify(claudeJsonOriginal)) {
        await this.writeAtomic(claudeJsonPath, JSON.stringify(cleaned, null, 2) + '\n', false);
      }
    }
  }

  async installCodex(host: HookHostKey): Promise<void> {
    return this.serializeMutation(() => this.installCodexNow(host));
  }

  private async installCodexNow(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.codexConfigPath(target);
    const keyPath = codexConfigKeyPath(target);
    const original = await readTomlOrNull(filePath);
    let updated = mergeCodexHooks(original ?? {}, HOOK_COMMAND_CODEX, keyPath);
    if (this.bridge) {
      const url = await this.resolveMcpUrlForHost(target);
      updated = mergeCodexMcp(updated, { url });
    }
    await this.writeAtomic(filePath, stringifyToml(updated), original !== null);
  }

  async uninstallCodex(host: HookHostKey): Promise<void> {
    return this.serializeMutation(() => this.uninstallCodexNow(host));
  }

  async installCursor(host: HookHostKey): Promise<void> {
    return this.serializeMutation(() => this.installCursorNow(host));
  }

  private async installCursorNow(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.cursorConfigPath(target);
    const original = await readJsonOrNull(filePath);
    if (!this.bridge) throw new Error('bridge identity not configured');
    const url = await this.resolveMcpUrlForHost(target);
    const updated = mergeCursorMcp(original ?? {}, { url, token: this.bridge.token });
    await this.writeAtomic(filePath, JSON.stringify(updated, null, 2) + '\n', original !== null);
  }

  async uninstallCursor(host: HookHostKey): Promise<void> {
    return this.serializeMutation(async () => {
      const target = this.requireHost(host);
      const filePath = this.cursorConfigPath(target);
      const original = await readJsonOrNull(filePath);
      if (!original) return;
      await this.writeAtomic(filePath, JSON.stringify(removeSoloeFromCursor(original), null, 2) + '\n', false);
    });
  }

  private async uninstallCodexNow(host: HookHostKey): Promise<void> {
    const target = this.requireHost(host);
    const filePath = this.codexConfigPath(target);
    const keyPath = codexConfigKeyPath(target);
    const original = await readTomlOrNull(filePath);
    if (!original) return;
    const cleaned = removeSoloeFromCodex(original, keyPath);
    await this.writeAtomic(filePath, stringifyToml(cleaned), false);
  }

  // Walks every available host with an existing soloe install and either:
  //   - runs a full re-install when the host's recorded _soloe_version is
  //     older than SOLOE_HOOK_VERSION (covers schema migrations like the
  //     `[features].codex_hooks` → `[features].hooks` rename), or
  //   - rewrites the MCP URL/token when the resolved value drifted while
  //     the rest of the install is current (cheap path for WSL host moves).
  // No-op for hosts where soloe was never installed. Returns hosts that
  // were actually rewritten so the caller can log/notify. Bridge must be
  // configured.
  async refreshMcpForInstalledHosts(): Promise<RefreshMcpResult> {
    return this.serializeMutation(() => this.refreshMcpForInstalledHostsNow());
  }

  private async refreshMcpForInstalledHostsNow(): Promise<RefreshMcpResult> {
    const result: RefreshMcpResult = { rewritten: [], errors: [] };
    if (!this.bridge) return result;
    for (const host of this.hostsList) {
      if (!host.available) continue;
      const key: HookHostKey = host.kind === 'wsl'
        ? { kind: 'wsl', distro: host.distro ?? '' }
        : { kind: host.kind };
      try {
        const url = await this.resolveMcpUrlForHost(host);
        const claudeChanged = await this.refreshClaudeHost(host, key, url);
        const codexChanged = await this.refreshCodexHost(host, key, url);
        const cursorChanged = await this.refreshCursorHost(host, key, url);
        if (claudeChanged || codexChanged || cursorChanged) result.rewritten.push(key);
      } catch (err) {
        result.errors.push({ host: key, error: errorMessage(err) });
      }
    }
    return result;
  }

  private async refreshClaudeHost(host: HookHost, key: HookHostKey, url: string): Promise<boolean> {
    if (!this.bridge) return false;
    const settings = await readJsonOrNull(this.claudeUserPath(host));
    const claudeJson = await readJsonOrNull(this.claudeJsonPath(host));
    if (!settings && !claudeJson) return false;
    const status = combineClaudeSoloeStatus(settings, claudeJson);
    if (!status.installed) return false;
    if (typeof status.version === 'number' && status.version < SOLOE_HOOK_VERSION) {
      await this.installClaudeNow(key);
      return true;
    }
    return this.refreshClaudeMcp(host, url);
  }

  private async refreshCodexHost(host: HookHost, key: HookHostKey, url: string): Promise<boolean> {
    if (!this.bridge) return false;
    const filePath = this.codexConfigPath(host);
    const original = await readTomlOrNull(filePath);
    if (!original) return false;
    const status = codexSoloeStatus(original);
    if (!status.installed) return false;
    if (typeof status.version === 'number' && status.version < SOLOE_HOOK_VERSION) {
      await this.installCodexNow(key);
      return true;
    }
    return this.refreshCodexMcp(host, url);
  }

  private async refreshCursorHost(host: HookHost, key: HookHostKey, url: string): Promise<boolean> {
    if (!this.bridge) return false;
    const filePath = this.cursorConfigPath(host);
    const original = await readJsonOrNull(filePath);
    if (!original || !cursorSoloeStatus(original).installed) return false;
    if ((cursorSoloeStatus(original).version ?? 0) < SOLOE_HOOK_VERSION) {
      await this.installCursorNow(key);
      return true;
    }
    const servers = isObject(original['mcpServers']) ? original['mcpServers'] : null;
    const entry = servers && isObject(servers[SOLOE_MCP_NAME]) ? servers[SOLOE_MCP_NAME] : null;
    if (entry && entry['url'] === url && this.bearerHeaderMatches(entry, this.bridge.token)) return false;
    await this.writeAtomic(filePath, JSON.stringify(mergeCursorMcp(original, { url, token: this.bridge.token }), null, 2) + '\n', true);
    return true;
  }

  private async refreshClaudeMcp(host: HookHost, url: string): Promise<boolean> {
    if (!this.bridge) return false;
    const filePath = this.claudeJsonPath(host);
    const original = await readJsonOrNull(filePath);
    if (!original) return false;
    const servers = isObject(original['mcpServers']) ? original['mcpServers'] : null;
    const entry = servers ? servers[SOLOE_MCP_NAME] : null;
    if (!isObject(entry) || entry[SOLOE_MARKER] !== true) return false;
    if (entry['url'] === url && this.bearerHeaderMatches(entry, this.bridge.token)) return false;
    const updated = mergeClaudeMcp(original, { url, token: this.bridge.token });
    await this.writeAtomic(filePath, JSON.stringify(updated, null, 2) + '\n', true);
    return true;
  }

  private async refreshCodexMcp(host: HookHost, url: string): Promise<boolean> {
    if (!this.bridge) return false;
    const filePath = this.codexConfigPath(host);
    const original = await readTomlOrNull(filePath);
    if (!original) return false;
    const servers = isObject(original['mcp_servers']) ? original['mcp_servers'] : null;
    const entry = servers ? servers[SOLOE_MCP_NAME] : null;
    if (!isObject(entry) || entry[SOLOE_MARKER] !== true) return false;
    if (entry['url'] === url) return false;
    const updated = mergeCodexMcp(original, { url });
    await this.writeAtomic(filePath, stringifyToml(updated), true);
    return true;
  }

  private bearerHeaderMatches(entry: Record<string, unknown>, token: string): boolean {
    const headers = entry['headers'];
    if (!isObject(headers)) return false;
    return headers['Authorization'] === `Bearer ${token}`;
  }

  private async resolveMcpUrlForHost(host: HookHost): Promise<string> {
    if (!this.bridge) throw new Error('bridge identity not configured');
    if (host.kind === 'wsl') {
      const hostname = await this.wslHostnameProbe(host.distro ?? '');
      return `http://${hostname}:${this.bridge.port}/mcp`;
    }
    return `http://127.0.0.1:${this.bridge.port}/mcp`;
  }

  private requireHost(key: HookHostKey): HookHost {
    const host = this.hostsList.find((h) =>
      h.kind === key.kind && (key.kind !== 'wsl' || h.distro === key.distro)
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

  // Claude Code's user-scope MCP server list lives here, not in
  // ~/.claude/settings.json. Editing the wrong file is a silent failure —
  // Claude Code launches without the soloe entry attached.
  private claudeJsonPath(host: HookHost): string {
    return path.join(host.homeDir, '.claude.json');
  }

  private codexConfigPath(host: HookHost): string {
    return path.join(host.homeDir, '.codex', 'config.toml');
  }

  private cursorConfigPath(host: HookHost): string {
    return path.join(host.homeDir, '.cursor', 'mcp.json');
  }

  private async claudeHostSoloeStatus(host: HookHost): Promise<AgentIntegrationTargetStatus> {
    const [settings, claudeJson] = await Promise.all([
      readJsonOrNull(this.claudeUserPath(host)),
      readJsonOrNull(this.claudeJsonPath(host))
    ]);
    return combineClaudeSoloeStatus(settings, claudeJson);
  }

  private async codexFileSoloeStatus(filePath: string): Promise<AgentIntegrationTargetStatus> {
    const data = await readTomlOrNull(filePath);
    if (!data) return emptyStatus();
    return codexSoloeStatus(data);
  }

  private async cursorFileSoloeStatus(filePath: string): Promise<AgentIntegrationTargetStatus> {
    const data = await readJsonOrNull(filePath);
    return data ? cursorSoloeStatus(data) : emptyStatus();
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
          await fs.writeFile(backupPath, existing, {
            encoding: 'utf8',
            mode: 0o600
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function describeHostKey(key: HookHostKey): string {
  return key.kind === 'wsl' ? `wsl:${key.distro}` : key.kind;
}

function publicHost(host: HookHost): AgentIntegrationHost {
  return {
    kind: host.kind,
    ...(host.distro ? { distro: host.distro } : {}),
    label: host.label,
    available: host.available,
    ...(host.reason ? { reason: host.reason } : {})
  };
}

// Path codex itself reads when loading user-level config. For local hosts this
// matches the path Soloe writes to. For WSL hosts, Soloe writes through a UNC
// (\\wsl.localhost\<distro>\...), but codex inside the distro sees the Linux
// path — and that's what feeds into hook-state keys, so we reconstruct it
// from homeLinux.
export function codexConfigKeyPath(host: HookHost): string {
  if (host.kind === 'wsl' && host.homeLinux) {
    return `${host.homeLinux}/.codex/config.toml`;
  }
  return path.join(host.homeDir, '.codex', 'config.toml');
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

export function mcpUrlForHost(host: HookHost, port: number): string {
  const hostname = host.kind === 'wsl' ? 'host.wsl.internal' : '127.0.0.1';
  return `http://${hostname}:${port}/mcp`;
}

export function mergeClaudeMcp(
  original: Record<string, unknown>,
  args: { url: string; token: string }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const servers = isObject(next['mcpServers']) ? { ...next['mcpServers'] } : {};
  servers[SOLOE_MCP_NAME] = {
    [SOLOE_MARKER]: true,
    [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION,
    type: 'http',
    url: args.url,
    headers: { Authorization: `Bearer ${args.token}` }
  };
  next['mcpServers'] = servers;
  return next;
}

export function mergeCursorMcp(
  original: Record<string, unknown>,
  args: { url: string; token: string }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const servers = isObject(next['mcpServers']) ? { ...next['mcpServers'] } : {};
  servers[SOLOE_MCP_NAME] = {
    [SOLOE_MARKER]: true,
    [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION,
    url: args.url,
    headers: { Authorization: `Bearer ${args.token}` }
  };
  next['mcpServers'] = servers;
  return next;
}

export function removeSoloeFromCursor(original: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  if (!isObject(next['mcpServers'])) return next;
  const servers: Record<string, unknown> = { ...next['mcpServers'] };
  for (const [name, entry] of Object.entries(servers)) {
    if (isObject(entry) && entry[SOLOE_MARKER] === true) delete servers[name];
  }
  if (Object.keys(servers).length) next['mcpServers'] = servers;
  else delete next['mcpServers'];
  return next;
}

export function mergeCodexMcp(
  original: Record<string, unknown>,
  args: { url: string }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const servers = isObject(next['mcp_servers']) ? { ...next['mcp_servers'] } : {};
  servers[SOLOE_MCP_NAME] = {
    [SOLOE_MARKER]: true,
    [SOLOE_VERSION_KEY]: SOLOE_HOOK_VERSION,
    url: args.url,
    bearer_token_env_var: SOLOE_BRIDGE_TOKEN_ENV
  };
  next['mcp_servers'] = servers;
  return next;
}

export function mergeClaudeHooks(
  original: Record<string, unknown>,
  command: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const hooksRoot = isObject(next['hooks']) ? { ...next['hooks'] } : {};
  removeSoloeEntriesFromHooksRoot(hooksRoot, isSoloeClaudeEntry);
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

function removeSoloeEntriesFromHooksRoot(
  hooksRoot: Record<string, unknown>,
  isSoloeEntry: (entry: unknown) => boolean
): void {
  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter((entry) => !isSoloeEntry(entry));
    if (filtered.length === 0) {
      delete hooksRoot[event];
    } else {
      hooksRoot[event] = filtered;
    }
  }
}

export function removeSoloeFromClaude(
  original: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  if (isObject(next['hooks'])) {
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
  }
  if (isObject(next['mcpServers'])) {
    const servers: Record<string, unknown> = { ...next['mcpServers'] };
    for (const name of Object.keys(servers)) {
      const entry = servers[name];
      if (isObject(entry) && entry[SOLOE_MARKER] === true) {
        delete servers[name];
      }
    }
    if (Object.keys(servers).length === 0) {
      delete next['mcpServers'];
    } else {
      next['mcpServers'] = servers;
    }
  }
  return next;
}

export function mergeCodexHooks(
  original: Record<string, unknown>,
  command: string,
  configKeyPath: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  const features = isObject(next['features']) ? { ...next['features'] } : {};
  features['hooks'] = true;
  delete features['codex_hooks'];
  next['features'] = features;
  const hooksRoot = isObject(next['hooks']) ? { ...next['hooks'] } : {};
  const stateRoot = isObject(hooksRoot['state']) ? { ...hooksRoot['state'] } : {};
  for (const event of CODEX_EVENTS) {
    const groups = Array.isArray(hooksRoot[event]) ? [...(hooksRoot[event] as unknown[])] : [];
    const filtered = groups.filter((entry) => !isSoloeCodexEntry(entry));
    const groupIndex = filtered.length;
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
    // Pre-trust the hook so codex 0.129+ runs it without manual /hooks review.
    // Codex matches `current_hash == trusted_hash` at hook-discovery time; if
    // a third-party tool reorders our group later, our key drifts and codex
    // re-flags us as untrusted — recovers on next soloe boot via reinstall.
    const stateKey = codexHookStateKey(configKeyPath, event, groupIndex, 0);
    stateRoot[stateKey] = {
      enabled: true,
      trusted_hash: codexCommandHookHash(event, command)
    };
  }
  if (Object.keys(stateRoot).length > 0) {
    hooksRoot['state'] = stateRoot;
  }
  next['hooks'] = hooksRoot;
  return next;
}

// Mirrors codex-rs/hooks/src/lib.rs::hook_key.
function codexHookStateKey(
  configKeyPath: string,
  event: string,
  groupIndex: number,
  handlerIndex: number
): string {
  const label = CODEX_EVENT_LABEL[event] ?? event;
  return `${configKeyPath}:${label}:${groupIndex}:${handlerIndex}`;
}

// Replicates codex-rs/hooks/src/engine/discovery.rs::command_hook_hash for the
// shape soloe always installs: no matcher, no statusMessage, async=false,
// timeout normalized to 600. Codex's pipeline is:
//   TomlValue::try_from(NormalizedHookIdentity)  // omits None Options
//     -> serde_json::to_value
//     -> canonical_json (sort keys recursively)
//     -> serde_json::to_vec (compact)
//     -> sha256 -> hex -> "sha256:<hex>"
// Our identity object is already key-sorted at every level, so JSON.stringify
// produces the canonical bytes directly.
export function codexCommandHookHash(event: string, command: string): string {
  const label = CODEX_EVENT_LABEL[event] ?? event;
  const identity = {
    event_name: label,
    hooks: [
      {
        async: false,
        command,
        timeout: 600,
        type: 'command'
      }
    ]
  };
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `sha256:${digest}`;
}

export function removeSoloeFromCodex(
  original: Record<string, unknown>,
  configKeyPath: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original };
  if (isObject(next['hooks'])) {
    const hooksRoot: Record<string, unknown> = { ...next['hooks'] };
    const stateKeysToDrop: string[] = [];
    for (const event of Object.keys(hooksRoot)) {
      if (event === 'state') continue;
      const groups = hooksRoot[event];
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, idx) => {
        if (isSoloeCodexEntry(group)) {
          stateKeysToDrop.push(codexHookStateKey(configKeyPath, event, idx, 0));
        }
      });
      const cleaned = groups
        .map((group) => stripSoloeFromGroup(group))
        .filter((group) => group !== null);
      if (cleaned.length === 0) {
        delete hooksRoot[event];
      } else {
        hooksRoot[event] = cleaned;
      }
    }
    if (isObject(hooksRoot['state']) && stateKeysToDrop.length > 0) {
      const stateRoot: Record<string, unknown> = { ...hooksRoot['state'] };
      for (const key of stateKeysToDrop) {
        delete stateRoot[key];
      }
      if (Object.keys(stateRoot).length === 0) {
        delete hooksRoot['state'];
      } else {
        hooksRoot['state'] = stateRoot;
      }
    }
    if (Object.keys(hooksRoot).length === 0) {
      delete next['hooks'];
    } else {
      next['hooks'] = hooksRoot;
    }
  }
  if (isObject(next['mcp_servers'])) {
    const servers: Record<string, unknown> = { ...next['mcp_servers'] };
    for (const name of Object.keys(servers)) {
      const entry = servers[name];
      if (isObject(entry) && entry[SOLOE_MARKER] === true) {
        delete servers[name];
      }
    }
    if (Object.keys(servers).length === 0) {
      delete next['mcp_servers'];
    } else {
      next['mcp_servers'] = servers;
    }
  }
  return next;
}

// Strips just the soloe MCP entry — used as a one-shot migration when writing
// settings.json on v14+, so any stale block left there by ≤v13 goes away.
function stripSoloeMcpEntry(data: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(data['mcpServers'])) return data;
  const servers: Record<string, unknown> = { ...data['mcpServers'] };
  let removed = false;
  for (const name of Object.keys(servers)) {
    const entry = servers[name];
    if (isObject(entry) && entry[SOLOE_MARKER] === true) {
      delete servers[name];
      removed = true;
    }
  }
  if (!removed) return data;
  const next: Record<string, unknown> = { ...data };
  if (Object.keys(servers).length === 0) {
    delete next['mcpServers'];
  } else {
    next['mcpServers'] = servers;
  }
  return next;
}

// Combines status across the two Claude config files. settings.json owns
// hooks; claude.json owns the MCP entry. A host counts as installed if either
// file has a soloe marker; the lowest version across both drives "current".
function combineClaudeSoloeStatus(
  settings: Record<string, unknown> | null,
  claudeJson: Record<string, unknown> | null
): AgentIntegrationTargetStatus {
  const versions: number[] = [];
  if (settings) collectClaudeVersions(settings, versions);
  if (claudeJson) collectClaudeVersions(claudeJson, versions);
  return statusFromVersions(versions);
}

function collectClaudeVersions(data: Record<string, unknown>, out: number[]): void {
  const hooks = data['hooks'];
  if (isObject(hooks)) {
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const version = soloeClaudeEntryVersion(group);
        if (version !== null) out.push(version);
      }
    }
  }
  const servers = data['mcpServers'];
  if (isObject(servers)) {
    for (const entry of Object.values(servers)) {
      const version = soloeMcpEntryVersion(entry);
      if (version !== null) out.push(version);
    }
  }
}

function codexSoloeStatus(data: Record<string, unknown>): AgentIntegrationTargetStatus {
  const versions: number[] = [];
  const hooks = data['hooks'];
  if (isObject(hooks)) {
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const version = soloeCodexEntryVersion(group);
        if (version !== null) versions.push(version);
      }
    }
  }
  const servers = data['mcp_servers'];
  if (isObject(servers)) {
    for (const entry of Object.values(servers)) {
      const version = soloeMcpEntryVersion(entry);
      if (version !== null) versions.push(version);
    }
  }
  return statusFromVersions(versions);
}

function cursorSoloeStatus(data: Record<string, unknown>): AgentIntegrationTargetStatus {
  const versions: number[] = [];
  const servers = data['mcpServers'];
  if (isObject(servers)) {
    for (const entry of Object.values(servers)) {
      const version = soloeMcpEntryVersion(entry);
      if (version !== null) versions.push(version);
    }
  }
  return statusFromVersions(versions);
}

function soloeMcpEntryVersion(entry: unknown): number | null {
  if (!isObject(entry)) return null;
  if (entry[SOLOE_MARKER] !== true) return null;
  return markerVersion(entry);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
