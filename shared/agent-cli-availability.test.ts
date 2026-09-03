import { describe, expect, it } from 'vitest';
import {
  agentCliUnavailableReason,
  isAgentCliAvailable
} from './agent-cli-availability.js';

describe('agent CLI availability', () => {
  it('treats a catalog entry as proof the agent CLI is installed', () => {
    expect(isAgentCliAvailable(
      [{ provider: 'claude', id: 'sonnet', label: 'Sonnet' }],
      'claude_code'
    )).toBe(true);
    expect(isAgentCliAvailable(
      [{ provider: 'claude', id: 'sonnet', label: 'Sonnet' }],
      'codex'
    )).toBe(false);
  });

  it('names the missing CLI for launch affordances', () => {
    expect(agentCliUnavailableReason('cursor')).toContain('Cursor Agent CLI');
    expect(agentCliUnavailableReason('grok_build')).toContain('Grok Build CLI');
    expect(agentCliUnavailableReason('antigravity')).toContain('Antigravity CLI');
  });
});
