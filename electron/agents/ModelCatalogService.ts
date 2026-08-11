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
      claude: settings.binaries.claude ?? 'claude'
    });
    if (this.cache?.key === key && this.cache.expiresAt > Date.now()) {
      return this.cache.catalog.map((entry) => ({ ...entry }));
    }

    const [codex, claude] = await Promise.all([
      this.discoverCodex(settings.binaries),
      this.discoverClaude(settings.binaries)
    ]);
    const catalog = dedupeCatalog([...codex, ...claude]);
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
}

function defaultEntry(provider: 'codex' | 'claude'): ModelCatalogEntry {
  return { ...CLI_DEFAULT_MODEL_CATALOG.find((entry) => entry.provider === provider)! };
}

function humanizeModelId(id: string): string {
  return id.split('-').map((part) =>
    part.toLowerCase() === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)
  ).join(' ');
}

function humanizeClaudeModel(id: string): string {
  if (!id.startsWith('claude-')) {
    return `Claude ${id.charAt(0).toUpperCase()}${id.slice(1)} (latest)`;
  }
  return humanizeModelId(id);
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
