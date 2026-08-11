import type {
  ModelCatalogEntry,
  ModelProvider,
  ModelSelection,
  ModelTask,
  Settings
} from './types/settings.js';

export const CLI_DEFAULT_MODEL_ID = '__cli_default__';

export const CLI_DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    provider: 'codex',
    id: CLI_DEFAULT_MODEL_ID,
    label: 'Codex default',
    isDefault: true
  },
  {
    provider: 'claude',
    id: CLI_DEFAULT_MODEL_ID,
    label: 'Claude default',
    isDefault: true
  }
];

export function modelCatalogFor(
  catalog: ModelCatalogEntry[],
  provider: ModelProvider
): ModelCatalogEntry[] {
  return catalog.filter((model) => model.provider === provider);
}

export type ModelCandidatePolicy =
  | { candidates: ModelSelection[]; reason?: never }
  | { candidates: []; reason: 'claude_blocked' };

export function modelCandidatesForTask(
  settings: Settings,
  catalog: ModelCatalogEntry[],
  task: ModelTask,
  fallbackTask?: ModelTask
): ModelCandidatePolicy {
  const configured = settings.models[task] ?? (fallbackTask ? settings.models[fallbackTask] : undefined);
  const claudeAllowed = settings.integrations.allowClaudeHeadless === true;
  if (configured?.provider === 'claude' && !claudeAllowed) {
    return { candidates: [], reason: 'claude_blocked' };
  }

  const allowed = catalog.filter(
    (model) => model.provider !== 'claude' || claudeAllowed
  );
  const candidates: ModelSelection[] = [];
  const add = (selection: ModelSelection | undefined) => {
    if (!selection) return;
    if (candidates.some((candidate) =>
      candidate.provider === selection.provider && candidate.id === selection.id
    )) return;
    candidates.push(selection);
  };

  if (configured && allowed.some((model) =>
    model.provider === configured.provider && model.id === configured.id
  )) {
    add(configured);
  }

  const providerOrder: ModelProvider[] =
    settings.binaries.claude && !settings.binaries.codex
      ? ['claude', 'codex']
      : ['codex', 'claude'];
  for (const provider of providerOrder) {
    const first = allowed.find((model) => model.provider === provider);
    if (first) add({ provider: first.provider, id: first.id });
  }
  return { candidates };
}
