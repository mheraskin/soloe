import { spawn } from 'node:child_process';
import type {
  ModelCatalogEntry,
  Settings,
  SettingsBinaries
} from '@shared/types/settings.js';
import {
  CLI_DEFAULT_MODEL_CATALOG
} from '@shared/model-catalog.js';

export interface ModelCatalogCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ModelCatalogServiceOptions {
  getSettings: () => Promise<Settings> | Settings;
  runCommand?: (executable: string, args: string[]) => Promise<ModelCatalogCommandResult>;
  cacheMs?: number;
}

interface CodexModelRecord {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
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
    const result = await this.runCommand(executable, ['debug', 'models']);
    if (result.exitCode !== 0) {
      const help = await this.runCommand(executable, ['--help']);
      return help.exitCode === 0 ? [defaultEntry('codex')] : [];
    }
    try {
      const parsed = JSON.parse(result.stdout) as { models?: CodexModelRecord[] };
      const models = (parsed.models ?? [])
        .filter((model) =>
          typeof model.slug === 'string'
          && model.slug.length > 0
          && model.visibility === 'list'
          && model.supported_in_api !== false
        )
        .sort((a, b) => numericPriority(a.priority) - numericPriority(b.priority))
        .map<ModelCatalogEntry>((model) => ({
          provider: 'codex',
          id: model.slug as string,
          label: typeof model.display_name === 'string' && model.display_name.trim()
            ? model.display_name.trim()
            : humanizeModelId(model.slug as string)
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

function numericPriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
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
  args: string[]
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
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += String(chunk);
    });
    child.once('error', () => finish(-1));
    child.once('close', (code) => finish(code ?? -1));
    const timeout = setTimeout(() => {
      child.kill();
      finish(-1);
    }, 10_000);
  });
}
