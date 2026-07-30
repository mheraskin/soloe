import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { FilesIpc } from './files.ipc.js';

let root: string;

beforeEach(async () => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-files-ipc-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FilesIpc Worktree File Index routing', () => {
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

  it('returns a bounded text preview instead of materializing a large file', async () => {
    const fileIndex = fakeIndex();
    const ipc = createIpc(fileIndex);
    ipc.register();
    const content = '0123456789abcdef\n'.repeat(40_000);
    await fs.writeFile(path.join(root, 'large.txt'), content, 'utf8');

    const result = await invoke(IpcChannels.files.readFile, {
      cwd: root,
      relativePath: 'large.txt',
      runMode: 'windows'
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        relativePath: 'large.txt',
        binary: false,
        truncated: true,
        size: Buffer.byteLength(content)
      }
    });
    const preview = (result as { value: { content: string } }).value.content;
    expect(preview.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(preview)).toBeLessThan(Buffer.byteLength(content));
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
    pty: {} as never
  });
}

async function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender: {} } as never, request as never);
}
