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
