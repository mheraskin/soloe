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
});
