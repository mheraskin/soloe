import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoRenameService } from './AutoRenameService.js';
import { SessionStore } from '../sessions/SessionStore.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import type { spawn } from 'node:child_process';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';

let tmpDir: string;
let sessionStore: SessionStore;
let settingsStore: SettingsStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-rename-'));
  sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
  settingsStore = new SettingsStore(path.join(tmpDir, 'settings.json'));
  await sessionStore.init();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('AutoRenameService', () => {
  it('does not start a second rename worker while one is already running for the session', async () => {
    const session = await sessionStore.create({
      name: 'new codex',
      cwd: tmpDir,
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    const children: FakeChild[] = [];
    const spawnImpl = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const service = new AutoRenameService({
      sessionStore,
      settings: settingsStore,
      spawnImpl
    });

    const first = service.maybeRename({ sessionId: session.id, firstPrompt: 'build analytics docs' });
    await waitFor(() => children.length === 1);

    await service.maybeRename({ sessionId: session.id, firstPrompt: 'rename me again' });

    children[0]!.succeed('analytics-docs\n');
    await first;

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect((await sessionStore.get(session.id))?.name).toBe('analytics-docs');
  });

  it('does not clobber a manual rename that happens while the agent spawn is in flight', async () => {
    const session = await sessionStore.create({
      name: 'new codex',
      cwd: tmpDir,
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    const children: FakeChild[] = [];
    const spawnImpl = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const service = new AutoRenameService({
      sessionStore,
      settings: settingsStore,
      spawnImpl
    });

    const pending = service.maybeRename({ sessionId: session.id, firstPrompt: 'build analytics docs' });
    await waitFor(() => children.length === 1);

    // User manually renames mid-flight — this is what SessionItem does on commit.
    await sessionStore.update(session.id, { name: 'my-cool-name', autoNamed: false });

    children[0]!.succeed('analytics-docs\n');
    await pending;

    const final = await sessionStore.get(session.id);
    expect(final?.name).toBe('my-cool-name');
    expect(final?.autoNamed).toBe(false);
  });

  it('falls back to an explicitly available Claude binary when no model is configured', async () => {
    const session = await sessionStore.create({
      name: 'new agent',
      cwd: tmpDir,
      runMode: 'windows',
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
    });
    const child = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => child);
    const spawnImpl = spawnMock as unknown as typeof spawn;
    const settings = {
      get: async () => ({
        ...DEFAULT_SETTINGS,
        binaries: { claude: '/opt/claude' },
        models: {},
        integrations: { ...DEFAULT_SETTINGS.integrations, allowClaudeHeadless: true }
      })
    } as unknown as SettingsStore;
    const service = new AutoRenameService({ sessionStore, settings, spawnImpl });

    const pending = service.maybeRename({ sessionId: session.id, firstPrompt: 'fix provider fallback' });
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('/opt/claude');
    child.succeed('provider-fallback\n');
    await pending;
  });

  it('replaces a stale saved model with a model discovered from the Codex harness', async () => {
    const session = await sessionStore.create({
      name: 'new codex',
      cwd: tmpDir,
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    await settingsStore.update({
      models: { textGeneration: { provider: 'codex', id: 'gpt-retired' } }
    });
    const child = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => child);
    const service = new AutoRenameService({
      sessionStore,
      settings: settingsStore,
      spawnImpl: spawnMock as unknown as typeof spawn,
      getModelCatalog: async () => [
        { provider: 'codex', id: CLI_DEFAULT_MODEL_ID, label: 'Codex default', isDefault: true },
        { provider: 'codex', id: 'gpt-current', label: 'GPT Current' }
      ]
    });

    const pending = service.maybeRename({ sessionId: session.id, firstPrompt: 'fix stale model' });
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('gpt-retired');
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('-m');
    child.succeed('fix-stale-model\n');
    await pending;

    expect((await sessionStore.get(session.id))?.name).toBe('fix-stale-model');
  });

  it('serializes background renames across different sessions', async () => {
    const created = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      sessionStore.create({
        name: `new agent ${index}`,
        cwd: tmpDir,
        runMode: 'windows',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      })));
    const children: FakeChild[] = [];
    const spawnImpl = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const service = new AutoRenameService({ sessionStore, settings: settingsStore, spawnImpl });

    const pending = created.map((session, index) => service.maybeRename({
      sessionId: session.id,
      firstPrompt: `rename session ${index}`
    }));
    await waitFor(() => children.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(children).toHaveLength(1);

    for (let index = 0; index < created.length; index += 1) {
      children[index]!.succeed(`session-${index}\n`);
      if (index < created.length - 1) await waitFor(() => children.length === index + 2);
    }
    await Promise.all(pending);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }

  succeed(output: string): void {
    this.stdout.write(output);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for predicate');
}
