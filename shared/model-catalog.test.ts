import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ModelCatalogEntry } from './types/settings.js';
import {
  CLI_DEFAULT_MODEL_ID,
  modelCandidatesForTask
} from './model-catalog.js';

const catalog: ModelCatalogEntry[] = [
  { provider: 'codex', id: CLI_DEFAULT_MODEL_ID, label: 'Codex default', isDefault: true },
  { provider: 'codex', id: 'gpt-current', label: 'GPT Current' },
  { provider: 'claude', id: CLI_DEFAULT_MODEL_ID, label: 'Claude default', isDefault: true },
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet' }
];

describe('modelCandidatesForTask', () => {
  it('drops a stale configured model and uses the discovered CLI default', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models.textGeneration = { provider: 'codex', id: 'gpt-retired' };

    expect(modelCandidatesForTask(settings, catalog, 'textGeneration')).toEqual({
      candidates: [{ provider: 'codex', id: CLI_DEFAULT_MODEL_ID }]
    });
  });

  it('keeps an available configured model ahead of provider defaults', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models.textGeneration = { provider: 'codex', id: 'gpt-current' };
    settings.integrations.allowClaudeHeadless = true;

    expect(modelCandidatesForTask(settings, catalog, 'textGeneration')).toEqual({
      candidates: [
        { provider: 'codex', id: 'gpt-current' },
        { provider: 'codex', id: CLI_DEFAULT_MODEL_ID },
        { provider: 'claude', id: CLI_DEFAULT_MODEL_ID }
      ]
    });
  });

  it('blocks an explicitly selected Claude model without headless opt-in', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models.worktreeOverview = { provider: 'claude', id: 'sonnet' };

    expect(
      modelCandidatesForTask(settings, catalog, 'worktreeOverview', 'textGeneration')
    ).toEqual({ candidates: [], reason: 'claude_blocked' });
  });
});
