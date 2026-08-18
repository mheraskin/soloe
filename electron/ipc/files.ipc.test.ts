import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  removeHandler: vi.fn(),
  createFromBuffer: vi.fn(() => ({ isEmpty: () => false })),
  writeImage: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  },
  nativeImage: { createFromBuffer: electronMocks.createFromBuffer },
  clipboard: { writeImage: electronMocks.writeImage }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { FilesIpc } from './files.ipc.js';

let root: string;

beforeEach(async () => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
  electronMocks.createFromBuffer.mockClear();
  electronMocks.writeImage.mockClear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-files-ipc-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FilesIpc Worktree File Index routing', () => {
  it('places agent images on Electron native clipboard before sending Ctrl+V', async () => {
    const write = vi.fn(async () => undefined);
    const ipc = new FilesIpc({
      fileIndex: fakeIndex() as never,
      store: {
        get: vi.fn(async () => ({
          id: 'session-1',
          launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
          name: 'codex',
          cwd: root,
          runMode: 'linux',
          createdAt: '2026-08-18T00:00:00.000Z',
          lastUsedAt: '2026-08-18T00:00:00.000Z'
        }))
      } as never,
      pty: {
        listRunning: () => [{ terminalId: 'terminal-1', sessionId: 'session-1' }],
        write
      } as never,
      authorizeScope: async () => true
    });
    const control = {
      sessionId: 'session-1',
      ownerDeviceId: 'device-owner',
      controllerDeviceId: 'device-controller',
      leaseId: 'lease-1'
    };

    await expect(ipc.pasteImagesIntoTerminal({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      images: [{
        mimeType: 'image/png',
        dataBase64: Buffer.from('png bytes').toString('base64')
      }],
      control
    })).resolves.toEqual({ paths: [], insertedText: '\x16' });

    expect(electronMocks.createFromBuffer).toHaveBeenCalledWith(Buffer.from('png bytes'));
    expect(electronMocks.writeImage).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('terminal-1', '\x16');
    ipc.dispose();
  });

  it('forwards exact search scope and tree force through one index', async () => {
    const fileIndex = fakeIndex();
    const ipc = createIpc(fileIndex);
    ipc.register();
    const scope = { cwd: '/repo', runMode: 'wsl' as const, wslDistro: 'Ubuntu' };

    await invoke(IpcChannels.files.search, { ...scope, query: 'app', limit: 20 });
    await invoke(IpcChannels.files.listTree, { ...scope, force: true });

    expect(fileIndex.search).toHaveBeenCalledWith(scope, 'app', 20);
    expect(fileIndex.inventory).toHaveBeenCalledWith(scope, { force: true });
    ipc.dispose();
    expect(fileIndex.dispose).toHaveBeenCalledOnce();
  });

  it('invalidates only the written Worktree Identity after atomic save', async () => {
    const fileIndex = fakeIndex();
    const ipc = createIpc(fileIndex);
    ipc.register();
    const request = {
      cwd: root,
      relativePath: 'src/new.ts',
      content: 'export const value = 1;\n',
      runMode: 'windows' as const
    };

    const result = await invoke(IpcChannels.files.writeFile, request);

    expect(result).toEqual({ ok: true, value: true });
    expect(fileIndex.invalidate).toHaveBeenCalledWith({
      cwd: root,
      runMode: 'windows'
    });
    await expect(fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8')).resolves.toBe(
      request.content
    );
    ipc.dispose();
  });
});

function fakeIndex() {
  return {
    search: vi.fn(async () => []),
    inventory: vi.fn(async () => ({ paths: ['README.md'], truncated: false, isRepo: true })),
    invalidate: vi.fn(),
    dispose: vi.fn()
  };
}

function createIpc(fileIndex: ReturnType<typeof fakeIndex>): FilesIpc {
  return new FilesIpc({
    fileIndex: fileIndex as never,
    store: {} as never,
    pty: {} as never,
    authorizeScope: async () => true
  });
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender: {} } as never, request as never);
}
