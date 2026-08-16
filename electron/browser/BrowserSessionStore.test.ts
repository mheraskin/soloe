import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSessionStore } from './BrowserSessionStore.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function storePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'soloe-browser-sessions-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'browser-sessions.json');
}

function state(url: string, id = 'tab-1') {
  return {
    tabs: [{ id, title: url, history: [url], historyIndex: 0 }],
    activeTabId: id
  };
}

describe('BrowserSessionStore', () => {
  it('survives a host restart and updates one Worktree scope without erasing another', async () => {
    const filePath = await storePath();
    const first = new BrowserSessionStore(filePath);
    await first.update({ scopeKey: 'worktree-a', state: state('http://localhost:3000') });
    await first.update({ scopeKey: 'worktree-b', state: state('https://example.test') });

    const restarted = new BrowserSessionStore(filePath);
    expect(await restarted.get()).toEqual({
      version: 1,
      scopeRecency: ['worktree-a', 'worktree-b'],
      scopes: {
        'worktree-a': state('http://localhost:3000'),
        'worktree-b': state('https://example.test')
      }
    });

    await restarted.update({
      scopeKey: 'worktree-a',
      state: state('http://localhost:4173', 'tab-2')
    });
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    expect(persisted.scopes['worktree-a']).toEqual(state('http://localhost:4173', 'tab-2'));
    expect(persisted.scopes['worktree-b']).toEqual(state('https://example.test'));
  });

  it('bounds untrusted tab history before writing it to disk', async () => {
    const filePath = await storePath();
    const store = new BrowserSessionStore(filePath);
    await store.update({
      scopeKey: 'worktree-a',
      state: {
        tabs: [{
          id: 'tab-1',
          title: 'x'.repeat(1_000),
          history: Array.from({ length: 150 }, (_, index) =>
            `https://example.test/${index}/${'x'.repeat(9_000)}`
          ),
          historyIndex: 149
        }],
        activeTabId: 'tab-1'
      }
    });

    const persisted = (await store.get()).scopes['worktree-a']!;
    expect(persisted.tabs[0]!.history.length).toBeLessThanOrEqual(100);
    expect(persisted.tabs[0]!.history[0]!.length).toBeLessThanOrEqual(8_192);
    expect(persisted.tabs[0]!.title).toHaveLength(512);
  });

  it('preserves a valid Device-qualified navigation target', async () => {
    const filePath = await storePath();
    const store = new BrowserSessionStore(filePath);
    const targetDevice = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      name: 'XPS',
      tailscaleDnsName: 'xps.tailnet.ts.net',
      local: false
    };
    await store.update({
      scopeKey: 'worktree-a',
      state: {
        tabs: [{
          id: 'tab-1',
          title: 'XPS · :3000',
          history: ['http://xps.tailnet.ts.net:3000/'],
          historyIndex: 0,
          targetDevice
        }],
        activeTabId: 'tab-1'
      }
    });

    expect((await store.get()).scopes['worktree-a']?.tabs[0]?.targetDevice).toEqual(targetDevice);
  });
});
