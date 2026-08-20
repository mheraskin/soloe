import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexShellSnapshotWatcher,
  parseCodexShellSnapshot
} from './CodexShellSnapshotWatcher.js';

describe('CodexShellSnapshotWatcher', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('maps a Codex shell snapshot to the Soloe tab that owns it', () => {
    expect(parseCodexShellSnapshot(
      '019fb4fd-8e4d-72e0-8d4f-88a36e3e629d.123.sh',
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    )).toEqual({
      soloeSessionId: 'codex-66d3c1',
      providerThreadId: '019fb4fd-8e4d-72e0-8d4f-88a36e3e629d'
    });
  });

  it('captures a resumed thread as soon as Codex writes its shell snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'soloe-codex-snapshots-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'shell_snapshots');
    mkdirSync(directory);
    const onThread = vi.fn();
    const watcher = new CodexShellSnapshotWatcher({ directory, onThread });
    await watcher.start();

    writeFileSync(
      join(directory, '019fb4fd-8e4d-72e0-8d4f-88a36e3e629d.456.sh'),
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    );

    await vi.waitFor(() => {
      expect(onThread).toHaveBeenCalledWith({
        soloeSessionId: 'codex-66d3c1',
        providerThreadId: '019fb4fd-8e4d-72e0-8d4f-88a36e3e629d'
      });
    });
    watcher.dispose();
  });

  it('reconciles the newest durable snapshot that existed before startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'soloe-codex-snapshots-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'shell_snapshots');
    mkdirSync(directory);
    writeFileSync(
      join(directory, '019fb4fd-8e4d-72e0-8d4f-88a36e3e629d.100.sh'),
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    );
    writeFileSync(
      join(directory, '01a019bf-f267-78c2-94bd-3f31f37f4ecd.200.sh'),
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    );
    const onThread = vi.fn();
    const watcher = new CodexShellSnapshotWatcher({
      directory,
      onThread,
      isThreadDurable: (thread) => thread.providerThreadId.startsWith('01a0')
    });

    await watcher.start();

    expect(onThread).toHaveBeenCalledTimes(1);
    expect(onThread).toHaveBeenCalledWith({
      soloeSessionId: 'codex-66d3c1',
      providerThreadId: '01a019bf-f267-78c2-94bd-3f31f37f4ecd'
    });
    watcher.dispose();
  });

  it('ignores temporary and non-durable bootstrap snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'soloe-codex-snapshots-'));
    temporaryDirectories.push(root);
    const directory = join(root, 'shell_snapshots');
    mkdirSync(directory);
    const onThread = vi.fn();
    const watcher = new CodexShellSnapshotWatcher({
      directory,
      onThread,
      isThreadDurable: () => false
    });
    await watcher.start();

    writeFileSync(
      join(directory, '01a019c8-8f8c-78a1-8865-fe5f760beeb0.tmp-300'),
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    );
    writeFileSync(
      join(directory, '01a019c8-8f8c-78a1-8865-fe5f760beeb0.300.sh'),
      "declare -x SOLOE_SESSION_ID='codex-66d3c1'\n"
    );

    await new Promise((resolve) => setTimeout(resolve, READ_RETRY_WINDOW_MS));
    expect(onThread).not.toHaveBeenCalled();
    watcher.dispose();
  });
});

const READ_RETRY_WINDOW_MS = 350;
