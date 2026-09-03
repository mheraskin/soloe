import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';
import {
  buildModelCatalogCommand,
  ModelCatalogService,
  parseAntigravityModels,
  parseCursorModels,
  parseOpenCodeModels
} from './ModelCatalogService.js';

describe('ModelCatalogService', () => {
  it('resolves bare Linux harnesses through the NVM-aware agent shell', () => {
    const command = buildModelCatalogCommand(
      'codex',
      ['app-server', '--listen', 'stdio://'],
      'linux'
    );

    expect(command.executable).toBe('bash');
    expect(command.args[0]).toBe('-lc');
    const script = decodeAgentScript(command.args[1] ?? '');
    expect(script).toContain('NVM_DIR');
    expect(script).toContain('__soloe_agent_bin="$(command -v codex 2>/dev/null)"');
    expect(script).toContain('exec "$__soloe_agent_bin" app-server --listen stdio://');
  });

  it('discovers visible Codex models and Claude aliases from installed harnesses', async () => {
    const runCommand = vi.fn(async (executable: string, _args: string[], stdin?: string) => {
      if (executable === 'codex') {
        expect(stdin).toContain('"method":"model/list"');
        expect(stdin).toContain('"includeHidden":false');
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            JSON.stringify({ id: 1, result: {} }),
            JSON.stringify({
              id: 2,
              result: {
                data: [
                  { id: 'hidden', model: 'hidden', displayName: 'Hidden', hidden: true },
                  {
                    id: 'gpt-current',
                    model: 'gpt-current',
                    displayName: 'GPT Current',
                    hidden: false,
                    isDefault: true
                  }
                ],
                nextCursor: null
              }
            })
          ].join('\n')
        };
      }
      if (executable === 'agent') return {
        exitCode: 0,
        stderr: '',
        stdout: 'auto\nsonnet-4.6-thinking\n'
      };
      return {
        exitCode: 0,
        stderr: '',
        stdout: "--model <model> alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or 'claude-fable-5'"
      };
    });
    const service = new ModelCatalogService({
      getSettings: () => DEFAULT_SETTINGS,
      runCommand
    });

    expect(await service.getCatalog()).toEqual(expect.arrayContaining([
      { provider: 'codex', id: CLI_DEFAULT_MODEL_ID, label: 'Codex default', isDefault: true },
      { provider: 'codex', id: 'gpt-current', label: 'GPT Current' },
      { provider: 'claude', id: 'fable', label: 'Claude Fable (latest)' },
      { provider: 'claude', id: 'claude-fable-5', label: 'Claude Fable 5' },
      { provider: 'cursor', id: CLI_DEFAULT_MODEL_ID, label: 'Cursor default', isDefault: true },
      { provider: 'cursor', id: 'sonnet-4.6-thinking', label: 'Sonnet 4.6 Thinking' }
    ]));
  });

  it('does not infer model ids from undocumented decorated Cursor output', () => {
    expect(parseCursorModels('* auto (current)\nmodel id  label')).toEqual([]);
  });

  it('parses OpenCode provider/model output without guessing decorated rows', () => {
    expect(parseOpenCodeModels([
      'anthropic/claude-sonnet-4-6',
      '\u001b[32mopenai/gpt-5.3-codex\u001b[0m',
      'model id  label',
      'anthropic/claude-sonnet-4-6'
    ].join('\n'))).toEqual([
      {
        provider: 'opencode',
        id: 'anthropic/claude-sonnet-4-6',
        label: 'Claude Sonnet 4 6 · Anthropic'
      },
      {
        provider: 'opencode',
        id: 'openai/gpt-5.3-codex',
        label: 'GPT 5.3 Codex · OpenAI'
      }
    ]);
  });

  it('parses Antigravity tab-separated model output', () => {
    expect(parseAntigravityModels([
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
    ].join('\n'))).toEqual([
      {
        provider: 'antigravity',
        id: 'gemini-3.8-flash-high',
        label: 'Gemini 3.8 Flash (High)'
      },
      {
        provider: 'antigravity',
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6 (Thinking)'
      },
      {
        provider: 'antigravity',
        id: 'gpt-oss-120b-medium',
        label: 'GPT-OSS 120B (Medium)'
      }
    ]);
  });

  it('caches discovery until invalidated', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: -1, stdout: '', stderr: '' }));
    const service = new ModelCatalogService({
      getSettings: () => DEFAULT_SETTINGS,
      runCommand
    });

    await service.getCatalog();
    await service.getCatalog();
    expect(runCommand).toHaveBeenCalledTimes(11);
    service.invalidate();
    await service.getCatalog();
    expect(runCommand).toHaveBeenCalledTimes(22);
  });
});

function decodeAgentScript(line: string): string {
  const encoded = line.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/u)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : line;
}
