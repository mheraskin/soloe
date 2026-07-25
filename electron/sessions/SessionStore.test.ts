import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from './SessionStore.js';
import type { SessionDraft } from '@shared/types/sessions.js';

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-store-'));
  storePath = path.join(tmpDir, 'sessions.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const standardDraft = (overrides: Record<string, unknown> = {}): SessionDraft =>
  ({
    name: 'My Session',
    cwd: '/home/me/proj',
    runMode: 'windows',
    launch: { type: 'terminal', shell: 'bash' },
    ...overrides
  }) as SessionDraft;

describe('SessionStore — create/list', () => {
  it('creates a session and lists it back', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('My Session');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
  });

  it('generates unique ids for sessions with the same name', async () => {
    const store = new SessionStore(storePath);
    const a = await store.create(standardDraft());
    const b = await store.create(standardDraft());
    expect(a.id).not.toBe(b.id);
  });
});

describe('SessionStore — validation', () => {
  it('allows only native Linux sessions in the Linux build', async () => {
    const store = new SessionStore(storePath, 'linux');
    await expect(store.create(standardDraft({ runMode: 'windows' }))).rejects.toThrow(
      /not available on linux/
    );
    await expect(store.create(standardDraft({ runMode: 'linux' }))).resolves.toMatchObject({
      runMode: 'linux'
    });
  });

  it('rejects an empty/whitespace name', async () => {
    const store = new SessionStore(storePath);
    await expect(store.create(standardDraft({ name: '   ' }))).rejects.toThrow(
      /name is required/
    );
    expect(await store.list()).toHaveLength(0);
  });

  it('rejects an empty cwd', async () => {
    const store = new SessionStore(storePath);
    await expect(store.create(standardDraft({ cwd: '' }))).rejects.toThrow(/cwd is required/);
  });

  it('rejects a wsl session that is missing wslDistro', async () => {
    const store = new SessionStore(storePath);
    await expect(store.create(standardDraft({ runMode: 'wsl' }))).rejects.toThrow(
      /wslDistro is required/
    );
  });

  it('rejects standard_terminal with shell=custom but no command', async () => {
    const store = new SessionStore(storePath);
    await expect(
      store.create(standardDraft({ launch: { type: 'terminal', shell: 'custom' } }))
    ).rejects.toThrow(/command is required/);
  });

  it('rejects claude resume_by_name without claudeSessionName', async () => {
    const store = new SessionStore(storePath);
    const draft: SessionDraft = {
      name: 'Claude',
      cwd: '/x',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'resume_by_name' }
    };
    await expect(store.create(draft)).rejects.toThrow(/claudeSessionName is required/);
  });

  it('rejects codex resume_by_id without codexSessionId', async () => {
    const store = new SessionStore(storePath);
    const draft: SessionDraft = {
      name: 'Codex',
      cwd: '/x',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'resume_by_id' }
    };
    await expect(store.create(draft)).rejects.toThrow(/codexSessionId is required/);
  });
});

describe('SessionStore — update/delete', () => {
  it('updates a session and re-validates the merged result', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());
    const renamed = await store.update(created.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    await expect(store.update(created.id, { name: '' })).rejects.toThrow(/name is required/);
    expect((await store.get(created.id))?.name).toBe('Renamed');
  });

  it('deletes a session and treats a repeat delete as an idempotent no-op', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());
    await store.delete(created.id);
    expect(await store.list()).toHaveLength(0);
    await expect(store.delete(created.id)).resolves.toBeUndefined();
  });

  it('archives a session by hiding it from list while preserving it by id', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft({ projectId: 'project-1' }));
    const archivedAt = new Date().toISOString();
    await store.update(created.id, { archivedAt });
    expect(await store.list()).toEqual([]);
    expect((await store.get(created.id))?.archivedAt).toBe(archivedAt);
  });
});

describe('SessionStore — disk round-trip', () => {
  it('persists across instances pointing at the same file', async () => {
    const a = new SessionStore(storePath);
    const created = await a.create(standardDraft({ name: 'Persisted' }));
    const b = new SessionStore(storePath);
    const fromDisk = await b.get(created.id);
    expect(fromDisk?.name).toBe('Persisted');
    expect((await b.list()).map((s) => s.id)).toEqual([created.id]);
  });

  it('returns an empty list when the storage file does not exist', async () => {
    const store = new SessionStore(path.join(tmpDir, 'no-such.json'));
    expect(await store.list()).toEqual([]);
  });

  it('backs up corrupt JSON and starts with an empty list', async () => {
    await fs.writeFile(storePath, '{ broken json', 'utf8');
    const store = new SessionStore(storePath);
    expect(await store.list()).toEqual([]);
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((f) => f.startsWith('sessions.json.corrupt-'))).toBe(true);
  });

  it('persists dangerous Claude sessions before user-input hooks arrive', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create({
      name: 'Claude',
      cwd: '/x',
      runMode: 'windows',
      launch: {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        extraArgs: ['--dangerously-skip-permissions']
      }
    });
    expect(created.hasUserInput).toBe(false);
    expect(created.launch).toMatchObject({
      type: 'agent',
      provider: 'claude_code',
      claudeSessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
    });
    expect(await store.list()).toHaveLength(1);

    const reloaded = new SessionStore(storePath);
    expect((await reloaded.list()).map((s) => s.id)).toEqual([created.id]);
    expect((await reloaded.get(created.id))?.launch).toEqual(created.launch);
  });

  it('preserves known-empty Claude sessions from older persisted storage', async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            kind: 'claude_code',
            id: 'empty-claude',
            name: 'Claude',
            cwd: '/x',
            runMode: 'windows',
            createdAt: '2026-01-01T00:00:00Z',
            lastUsedAt: '2026-01-01T00:00:00Z',
            resumeMode: 'new',
            hasUserInput: false
          }
        ]
      }),
      'utf8'
    );
    const store = new SessionStore(storePath);
    expect((await store.list()).map((s) => s.id)).toEqual(['empty-claude']);
  });
});
