import { modelCatalogProviderForRuntime } from './model-catalog.js';
import type { ModelCatalogEntry } from './types/settings.js';
import type { AgentRuntimeProvider } from './types/sessions.js';

/** True when the Device's model catalog includes at least one entry for the agent CLI. */
export function isAgentCliAvailable(
  catalog: ModelCatalogEntry[],
  provider: AgentRuntimeProvider
): boolean {
  const catalogProvider = modelCatalogProviderForRuntime(provider);
  return catalog.some((entry) => entry.provider === catalogProvider);
}

export function agentCliUnavailableReason(provider: AgentRuntimeProvider): string {
  switch (provider) {
    case 'claude_code':
      return 'Claude CLI is not installed on this Device';
    case 'codex':
      return 'Codex CLI is not installed on this Device';
    case 'cursor':
      return 'Cursor Agent CLI is not installed on this Device';
    case 'opencode':
      return 'OpenCode CLI is not installed on this Device';
    case 'grok_build':
      return 'Grok Build CLI is not installed on this Device';
    case 'antigravity':
      return 'Antigravity CLI is not installed on this Device';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
