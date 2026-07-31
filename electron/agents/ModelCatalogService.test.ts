import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';
import {
  buildModelCatalogCommand,
  ModelCatalogService
} from './ModelCatalogService.js';

describe('ModelCatalogService', () => {
  it('resolves bare Linux harnesses through the NVM-aware agent shell', () => {
    const command = buildModelCatalogCommand('codex', ['debug', 'models'], 'linux');

    expect(command.executable).toBe('bash');
    expect(command.args[0]).toBe('-lc');
    const script = decodeAgentScript(command.args[1] ?? '');
    expect(script).toContain('NVM_DIR');
    expect(script).toContain('__soloe_agent_bin="$(command -v codex 2>/dev/null)"');
    expect(script).toContain('exec "$__soloe_agent_bin" debug models');
  });

  it('discovers visible Codex models and Claude aliases from installed harnesses', async () => {
    const runCommand = vi.fn(async (executable: string) => {
      if (executable === 'codex') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            models: [
              { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', supported_in_api: true },
              { slug: 'gpt-current', display_name: 'GPT Current', visibility: 'list', supported_in_api: true, priority: 1 }
            ]
          })
        };
      }
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
      { provider: 'claude', id: 'claude-fable-5', label: 'Claude Fable 5' }
    ]));
  });

  it('caches discovery until invalidated', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: -1, stdout: '', stderr: '' }));
    const service = new ModelCatalogService({
      getSettings: () => DEFAULT_SETTINGS,
      runCommand
    });

    await service.getCatalog();
    await service.getCatalog();
    expect(runCommand).toHaveBeenCalledTimes(3);
    service.invalidate();
    await service.getCatalog();
    expect(runCommand).toHaveBeenCalledTimes(6);
  });
});

function decodeAgentScript(line: string): string {
  const encoded = line.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/u)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : line;
}
