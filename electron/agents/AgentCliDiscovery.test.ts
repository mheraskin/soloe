import { describe, expect, it, vi } from 'vitest';
import { AgentCliDiscovery, enrichAgentCliStatus } from './AgentCliDiscovery.js';

describe('AgentCliDiscovery', () => {
  it('detects configured and default agent binaries per host', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'claude 1.2.3\n', stderr: '' });
    const discovery = new AgentCliDiscovery({ run });

    await expect(discovery.detect('claude', { kind: 'macos' })).resolves.toEqual({
      available: true,
      binary: 'claude',
      version: '1.2.3'
    });
    expect(run).toHaveBeenCalledWith('claude', ['--version']);
  });

  it('probes WSL hosts through wsl.exe', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'opencode 0.1.0', stderr: '' });
    const discovery = new AgentCliDiscovery({ run });

    await discovery.detect('opencode', { kind: 'wsl', distro: 'Ubuntu' }, '/usr/bin/opencode');
    expect(run).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', '/usr/bin/opencode', '--version']
    );
  });

  it('enriches every available host target with CLI availability', async () => {
    const discovery = {
      detect: vi.fn(async (provider: string) => ({
        available: provider === 'codex',
        binary: provider === 'codex' ? 'codex' : undefined,
        ...(provider === 'codex' ? { version: '1.0.0' } : { reason: `${provider} missing` })
      }))
    };
    const status = {
      hosts: [{
        host: { kind: 'linux' as const, label: 'Linux', available: true },
        claude: { installed: false, current: false },
        codex: { installed: false, current: false },
        cursor: { installed: false, current: false },
        opencode: { installed: false, current: false },
        grok: { installed: false, current: false }
      }]
    };

    const enriched = await enrichAgentCliStatus(status, undefined, discovery);
    expect(enriched.hosts[0]?.codex.cli).toEqual({
      available: true,
      binary: 'codex',
      version: '1.0.0'
    });
    expect(enriched.hosts[0]?.claude.cli?.available).toBe(false);
    expect(enriched.hosts[0]?.antigravity?.cli?.available).toBe(false);
    expect(discovery.detect).toHaveBeenCalledTimes(6);
  });

  it('detects antigravity via agy or antigravity candidate binaries', async () => {
    const run = vi.fn(async (cmd: string) => {
      if (cmd === 'agy') return { exitCode: 0, stdout: '1.1.25\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    });
    const discovery = new AgentCliDiscovery({ run });
    await expect(discovery.detect('antigravity', { kind: 'macos' })).resolves.toEqual({
      available: true,
      binary: 'agy',
      version: '1.1.25'
    });
  });
});
