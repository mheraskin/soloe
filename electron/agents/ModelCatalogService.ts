import { spawn } from 'node:child_process';
import type {
  ModelCatalogEntry,
  Settings,
  SettingsBinaries
} from '@shared/types/settings.js';
import {
  CLI_DEFAULT_MODEL_CATALOG
} from '@shared/model-catalog.js';
import { buildWslAgentLine } from '../sessions/SessionCommandBuilder.js';

export interface ModelCatalogCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ModelCatalogServiceOptions {
  getSettings: () => Promise<Settings> | Settings;
  runCommand?: (
    executable: string,
    args: string[],
    stdin?: string
  ) => Promise<ModelCatalogCommandResult>;
  cacheMs?: number;
}

interface CodexModelRecord {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
}

const CACHE_MS = 5 * 60_000;
const CLAUDE_STABLE_ALIASES = ['opus', 'sonnet', 'haiku'];

export class ModelCatalogService {
  private cache: { key: string; expiresAt: number; catalog: ModelCatalogEntry[] } | null = null;
  private readonly runCommand: NonNullable<ModelCatalogServiceOptions['runCommand']>;

  constructor(private readonly opts: ModelCatalogServiceOptions) {
    this.runCommand = opts.runCommand ?? runCatalogCommand;
  }

  async getCatalog(): Promise<ModelCatalogEntry[]> {
    const settings = await this.opts.getSettings();
    const key = JSON.stringify({
      codex: settings.binaries.codex ?? 'codex',
      claude: settings.binaries.claude ?? 'claude',
      cursor: settings.binaries.cursor ?? 'agent',
      opencode: settings.binaries.opencode ?? 'opencode',
      grok: settings.binaries.grok ?? 'grok',
      antigravity: settings.binaries.antigravity ?? 'agy'
    });
    if (this.cache?.key === key && this.cache.expiresAt > Date.now()) {
      return this.cache.catalog.map((entry) => ({ ...entry }));
    }

    const [codex, claude, cursor, opencode, grok, antigravity] = await Promise.all([
      this.discoverCodex(settings.binaries),
      this.discoverClaude(settings.binaries),
      this.discoverCursor(settings.binaries),
      this.discoverOpenCode(settings.binaries),
      this.discoverGrok(settings.binaries),
      this.discoverAntigravity(settings.binaries)
    ]);
    const catalog = dedupeCatalog([...codex, ...claude, ...cursor, ...opencode, ...grok, ...antigravity]);
    this.cache = {
      key,
      expiresAt: Date.now() + (this.opts.cacheMs ?? CACHE_MS),
      catalog
    };
    return catalog.map((entry) => ({ ...entry }));
  }

  invalidate(): void {
    this.cache = null;
  }

  private async discoverCodex(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const executable = binaries.codex || 'codex';
    const result = await this.runCommand(
      executable,
      ['app-server', '--listen', 'stdio://'],
      codexModelListRequest()
    );
    if (result.exitCode !== 0) {
      const help = await this.runCommand(executable, ['--help']);
      return help.exitCode === 0 ? [defaultEntry('codex')] : [];
    }
    try {
      const parsed = jsonRpcResult(result.stdout, 2) as { data?: CodexModelRecord[] } | null;
      const models = (parsed?.data ?? [])
        .filter((model) =>
          typeof model.model === 'string'
          && model.model.length > 0
          && model.hidden !== true
        )
        .map<ModelCatalogEntry>((model) => ({
          provider: 'codex',
          id: model.model as string,
          label: typeof model.displayName === 'string' && model.displayName.trim()
            ? model.displayName.trim()
            : humanizeModelId(model.model as string)
        }));
      return [defaultEntry('codex'), ...models];
    } catch {
      return [defaultEntry('codex')];
    }
  }

  private async discoverClaude(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const executable = binaries.claude || 'claude';
    const result = await this.runCommand(executable, ['--help']);
    if (result.exitCode !== 0) return [];
    const ids = new Set(CLAUDE_STABLE_ALIASES);
    for (const match of result.stdout.matchAll(/'((?:claude-)?[a-z][a-z0-9.-]*)'/giu)) {
      const id = match[1];
      if (id && (id.startsWith('claude-') || CLAUDE_STABLE_ALIASES.includes(id) || id === 'fable')) {
        ids.add(id);
      }
    }
    return [
      defaultEntry('claude'),
      ...[...ids].map<ModelCatalogEntry>((id) => ({
        provider: 'claude',
        id,
        label: humanizeClaudeModel(id)
      }))
    ];
  }

  private async discoverCursor(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const executable = binaries.cursor || 'agent';
    let result = await this.runCommand(executable, ['models']);
    if (result.exitCode !== 0 && !binaries.cursor && executable === 'agent') {
      result = await this.runCommand('cursor-agent', ['models']);
    }
    if (result.exitCode !== 0) return [];
    const models = parseCursorModels(result.stdout);
    return [defaultEntry('cursor'), ...models];
  }

  private async discoverOpenCode(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const executable = binaries.opencode || 'opencode';
    const result = await this.runCommand(executable, ['models']);
    if (result.exitCode !== 0) return [];
    return [defaultEntry('opencode'), ...parseOpenCodeModels(result.stdout)];
  }

  private async discoverGrok(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const executable = binaries.grok || 'grok';
    const result = await this.runCommand(executable, ['--version']);
    return result.exitCode === 0 ? [defaultEntry('grok_build')] : [];
  }

  private async discoverAntigravity(binaries: SettingsBinaries): Promise<ModelCatalogEntry[]> {
    const candidates = binaries.antigravity ? [binaries.antigravity] : ['agy', 'antigravity'];
    for (const executable of candidates) {
      const result = await this.runCommand(executable, ['models']);
      if (result.exitCode === 0) {
        const parsed = parseAntigravityModels(result.stdout);
        return [defaultEntry('antigravity'), ...parsed];
      }
      const help = await this.runCommand(executable, ['--help']);
      if (help.exitCode === 0) {
        return [defaultEntry('antigravity')];
      }
    }
    return [];
  }
}

function defaultEntry(provider: ModelCatalogEntry['provider']): ModelCatalogEntry {
  return { ...CLI_DEFAULT_MODEL_CATALOG.find((entry) => entry.provider === provider)! };
}

export function parseCursorModels(stdout: string): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const rawLine of stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Cursor documents the listing command but no machine-readable schema.
    // Accept only an unadorned identifier line; decorated/column output stays
    // unavailable rather than guessing where the identifier ends.
    const id = /^[a-z0-9][a-z0-9._/-]*$/iu.test(line) ? line : undefined;
    if (!id || /^(?:available|model|models)$/iu.test(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({ provider: 'cursor', id, label: humanizeModelId(id) });
  }
  return entries;
}

export function parseOpenCodeModels(stdout: string): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const rawLine of stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)) {
    const id = rawLine.trim();
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/iu.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    entries.push({ provider: 'opencode', id, label: humanizeOpenCodeModel(id) });
  }
  return entries;
}

export function parseAntigravityModels(stdout: string): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const rawLine of stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Fetching') || line.startsWith('Available')) continue;
    const parts = line.split('\t');
    const id = parts[0]?.trim();
    if (!id || /^(?:model|models)$/iu.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = parts[1]?.trim() || humanizeModelId(id);
    entries.push({ provider: 'antigravity', id, label });
  }
  return entries;
}

function humanizeModelId(id: string): string {
  return id.split('-').map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === 'gpt') return 'GPT';
    if (normalized === 'openai') return 'OpenAI';
    if (normalized === 'xai') return 'xAI';
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ');
}

function humanizeClaudeModel(id: string): string {
  if (!id.startsWith('claude-')) {
    return `Claude ${id.charAt(0).toUpperCase()}${id.slice(1)} (latest)`;
  }
  return humanizeModelId(id);
}

function humanizeOpenCodeModel(id: string): string {
  const separator = id.indexOf('/');
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  return `${humanizeModelId(model)} · ${humanizeModelId(provider)}`;
}

function dedupeCatalog(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.provider}\u001f${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runCatalogCommand(
  executable: string,
  args: string[],
  stdin?: string
): Promise<ModelCatalogCommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    };
    const command = buildModelCatalogCommand(executable, args);
    const child = spawn(command.executable, command.args, {
      windowsHide: true,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk);
      if (stdin !== undefined && jsonRpcResult(stdout, 2) !== null) {
        child.kill();
        finish(0);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk);
    });
    child.once('error', () => finish(-1));
    child.once('close', (code) => finish(code ?? -1));
    if (stdin !== undefined) child.stdin?.write(stdin);
    const timeout = setTimeout(() => {
      child.kill();
      finish(-1);
    }, 10_000);
  });
}

function codexModelListRequest(): string {
  return [
    JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'soloe', title: 'Soloe', version: '1.0.0' }
      }
    }),
    JSON.stringify({ method: 'initialized', params: {} }),
    JSON.stringify({
      method: 'model/list',
      id: 2,
      params: { limit: 100, includeHidden: false }
    })
  ].join('\n') + '\n';
}

function jsonRpcResult(stdout: string, id: number): unknown | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
      if (message.id !== id) continue;
      return Object.hasOwn(message, 'result') ? message.result : null;
    } catch {
      // Codex can print startup diagnostics before the JSON-RPC stream begins.
    }
  }
  return null;
}

export function buildModelCatalogCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { executable: string; args: string[] } {
  if (platform !== 'win32') {
    return {
      executable: 'bash',
      args: ['-lc', buildWslAgentLine({}, executable, args)]
    };
  }
  if (!/\.[a-z0-9]+$/iu.test(executable) || /\.(?:bat|cmd)$/iu.test(executable)) {
    return {
      executable: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', executable, ...args]
    };
  }
  return { executable, args };
}
