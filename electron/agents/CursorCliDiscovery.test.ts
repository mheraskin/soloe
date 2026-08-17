import { describe, expect, it, vi } from 'vitest';
import {
  CursorCliDiscovery,
  enrichCursorCliStatus,
  resolveCursorSessionBinaries
} from './CursorCliDiscovery.js';
import type { Session } from '@shared/types/sessions.js';

describe('CursorCliDiscovery', () => {
  it('detects the primary agent binary and version', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '2026.08.15-abc123\n', stderr: '' });
    const result = await new CursorCliDiscovery({ run }).detect({ kind: 'macos' });

    expect(run).toHaveBeenCalledWith('agent', ['--version']);
    expect(result).toEqual({ available: true, binary: 'agent', version: '2026.08.15-abc123' });
  });

  it('falls back to the documented cursor-agent alias', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ exitCode: 127, stdout: '', stderr: 'not found' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'cursor-agent 1.2.3', stderr: '' });
    const result = await new CursorCliDiscovery({ run }).detect({ kind: 'linux' });

    expect(result).toEqual({ available: true, binary: 'cursor-agent', version: '1.2.3' });
  });

  it('probes a WSL distro through wsl.exe', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'agent 1.0.0', stderr: '' });
    await new CursorCliDiscovery({ run }).detect({ kind: 'wsl', distro: 'Ubuntu' }, '/opt/cursor/agent');

    expect(run).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '--', '/opt/cursor/agent', '--version']);
  });

  it('reports a truthful unavailable reason', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'not found' });
    const result = await new CursorCliDiscovery({ run }).detect({ kind: 'windows' });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('agent');
    expect(result.reason).toContain('cursor-agent');
  });

  it('enriches legacy integration status without a Cursor field', async () => {
    const status = { hosts: [{
      host: { kind: 'macos' as const, label: 'This Mac', available: true },
      claude: { installed: false, current: false },
      codex: { installed: false, current: false }
    }] } as never;
    const discovery = { detect: vi.fn().mockResolvedValue({
      available: true, binary: 'agent', version: '1.0.0'
    }) };

    expect(await enrichCursorCliStatus(status, undefined, discovery)).toMatchObject({
      hosts: [{ cursor: { installed: false, current: false, cli: { available: true } } }]
    });
  });

  it('uses the discovered legacy alias for Cursor session launches', async () => {
    const session = {
      id: 'cursor-session',
      name: 'Cursor',
      cwd: '/repo',
      runMode: 'linux',
      launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z'
    } satisfies Session;
    const discovery = { detect: vi.fn().mockResolvedValue({
      available: true,
      binary: 'cursor-agent',
      version: '1.2.3'
    }) };

    await expect(resolveCursorSessionBinaries(session, {}, discovery)).resolves.toEqual({
      cursor: 'cursor-agent'
    });
    expect(discovery.detect).toHaveBeenCalledWith({ kind: 'linux' });
  });

  it('preserves an explicitly configured Cursor binary without probing', async () => {
    const session = {
      id: 'cursor-session',
      name: 'Cursor',
      cwd: '/repo',
      runMode: 'macos',
      launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z'
    } satisfies Session;
    const discovery = { detect: vi.fn() };

    await expect(resolveCursorSessionBinaries(
      session,
      { cursor: '/opt/cursor/agent' },
      discovery
    )).resolves.toEqual({ cursor: '/opt/cursor/agent' });
    expect(discovery.detect).not.toHaveBeenCalled();
  });

  it('fails a Cursor launch with the discovery reason when no CLI is available', async () => {
    const session = {
      id: 'cursor-session',
      name: 'Cursor',
      cwd: '/repo',
      runMode: 'linux',
      launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z'
    } satisfies Session;
    const discovery = { detect: vi.fn().mockResolvedValue({
      available: false,
      reason: 'Cursor Agent CLI is unavailable (tried agent and cursor-agent)'
    }) };

    await expect(resolveCursorSessionBinaries(session, {}, discovery)).rejects.toThrow(
      'Cursor Agent CLI is unavailable (tried agent and cursor-agent)'
    );
  });
});
