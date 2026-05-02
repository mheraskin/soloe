import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export type ClaudeScope = 'user' | 'project' | 'project_local';

export interface ClaudeStatus {
  user: boolean;
  project: boolean;
  projectLocal: boolean;
}

export interface HookInstallStatus {
  claude: ClaudeStatus;
  codex: boolean;
}

export interface HookInstallerOptions {
  homeDir?: string;
}

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
  'PreCompact',
  'SubagentStop'
];

const CODEX_EVENTS = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'permission_request',
  'stop'
];

const SOLOE_MARKER = '_soloe';
const HOOK_COMMAND_CLAUDE = buildHookCommand('claude');
const HOOK_COMMAND_CODEX = buildHookCommand('codex');

function buildHookCommand(provider: 'claude' | 'codex'): string {
  const endpoint = provider === 'claude' ? '/hook/claude' : '/hook/codex';
  return [
    '[ -z "$SOLOE_BRIDGE_URL" ] && exit 0',
    'curl -sS --max-time 1 -X POST',
    '-H "Authorization: Bearer $SOLOE_BRIDGE_TOKEN"',
    '-H "X-Soloe-Session-Id: $SOLOE_SESSION_ID"',
    '-H "Content-Type: application/json"',
    '--data-binary @-',
    `"$SOLOE_BRIDGE_URL${endpoint}"`,
    '>/dev/null 2>&1 || true'
  ].join(' ');
}

export class HookInstaller {
  private readonly homeDir: string;

  constructor(opts: HookInstallerOptions = {}) {
    this.homeDir = opts.homeDir ?? os.homedir();
  }

  async status(projectPath?: string): Promise<HookInstallStatus> {
    const [user, project, projectLocal, codex] = await Promise.all([
      this.claudeFileHasSoloe(this.claudeUserPath()),
      projectPath ? this.claudeFileHasSoloe(this.claudeProjectPath(projectPath)) : Promise.resolve(false),
      projectPath ? this.claudeFileHasSoloe(this.claudeProjectLocalPath(projectPath)) : Promise.resolve(false),
      this.codexFileHasSoloe(this.codexConfigPath())
    ]);
    return {
      claude: { user, project, projectLocal },
      codex
    };
  }

  async installClaude(scope: ClaudeScope, projectPath?: string): Promise<void> {
    const filePath = this.claudeFilePath(scope, projectPath);
    const original = await readJsonOrNull(filePath);
    const updated = mergeClaudeHooks(original ?? {}, HOOK_COMMAND_CLAUDE);
    await this.writeAtomic(filePath, JSON.stringify(updated, null, 2) + '\n', original !== null);
  }

  async uninstallClaude(scope: ClaudeScope, projectPath?: string): Promise<void> {
    const filePath = this.claudeFilePath(scope, projectPath);
    const original = await readJsonOrNull(filePath);
    if (!original) return;
    const cleaned = removeSoloeFromClaude(original);
    await this.writeAtomic(filePath, JSON.stringify(cleaned, null, 2) + '\n', false);
  }

  async installCodex(): Promise<void> {
    const filePath = this.codexConfigPath();
    const original = await readTomlOrNull(filePath);
    const updated = mergeCodexHooks(original ?? {}, HOOK_COMMAND_CODEX);
    await this.writeAtomic(filePath, stringifyToml(updated), original !== null);
  }

  async uninstallCodex(): Promise<void> {
    const filePath = this.codexConfigPath();
    const original = await readTomlOrNull(filePath);
    if (!original) return;
    const cleaned = removeSoloeFromCodex(original);
    await this.writeAtomic(filePath, stringifyToml(cleaned), false);
  }

  private claudeFilePath(scope: ClaudeScope, projectPath?: string): string {
    switch (scope) {
      case 'user':
        return this.claudeUserPath();
      case 'project':
        if (!projectPath) throw new Error('projectPath is required for project scope');
        return this.claudeProjectPath(projectPath);
      case 'project_local':
        if (!projectPath) throw new Error('projectPath is required for project_local scope');
        return this.claudeProjectLocalPath(projectPath);
    }
  }

  private claudeUserPath(): string {
    return path.join(this.homeDir, '.claude', 'settings.json');
  }

  private claudeProjectPath(projectPath: string): string {
    return path.join(projectPath, '.claude', 'settings.json');
  }

  private claudeProjectLocalPath(projectPath: string): string {
    return path.join(projectPath, '.claude', 'settings.local.json');
  }

  private codexConfigPath(): string {
    return path.join(this.homeDir, '.codex', 'config.toml');
  }

  private async claudeFileHasSoloe(filePath: string): Promise<boolean> {
    const data = await readJsonOrNull(filePath);
    if (!data) return false;
    return claudeHasSoloeEntry(data);
  }

  private async codexFileHasSoloe(filePath: string): Promise<boolean> {
    const data = await readTomlOrNull(filePath);
    if (!data) return false;
    return codexHasSoloeEntry(data);
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
      hooks: [
        {
          type: 'command',
          command,
          [SOLOE_MARKER]: true
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
  const hooksRoot = isObject(next['hooks']) ? { ...next['hooks'] } : {};
  for (const event of CODEX_EVENTS) {
    const entries = Array.isArray(hooksRoot[event])
      ? [...(hooksRoot[event] as unknown[])]
      : [];
    const filtered = entries.filter((entry) => !isSoloeCodexEntry(entry));
    filtered.push({
      type: 'command',
      command,
      [SOLOE_MARKER]: true
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
    const entries = hooksRoot[event];
    if (!Array.isArray(entries)) continue;
    const cleaned = entries.filter((entry) => !isSoloeCodexEntry(entry));
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

function claudeHasSoloeEntry(data: Record<string, unknown>): boolean {
  const hooks = data['hooks'];
  if (!isObject(hooks)) return false;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some(isSoloeClaudeEntry)) return true;
  }
  return false;
}

function codexHasSoloeEntry(data: Record<string, unknown>): boolean {
  const hooks = data['hooks'];
  if (!isObject(hooks)) return false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    if (entries.some(isSoloeCodexEntry)) return true;
  }
  return false;
}

function isSoloeClaudeEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (entry[SOLOE_MARKER] === true) return true;
  const inner = entry['hooks'];
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => isObject(h) && h[SOLOE_MARKER] === true);
}

function isSoloeCodexEntry(entry: unknown): boolean {
  return isObject(entry) && entry[SOLOE_MARKER] === true;
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
