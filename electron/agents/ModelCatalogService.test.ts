import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';
import { ModelCatalogService } from './ModelCatalogService.js';

describe('ModelCatalogService', () => {
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
