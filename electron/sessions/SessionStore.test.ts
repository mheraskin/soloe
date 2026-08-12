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

  it('creates and reloads only native macOS sessions in the macOS build', async () => {
    const store = new SessionStore(storePath, 'macos');
    const created = await store.create(standardDraft({ runMode: 'macos' }));

    await expect(
      new SessionStore(storePath, 'macos').get(created.id)
    ).resolves.toMatchObject({ runMode: 'macos' });
    await expect(
      store.create(standardDraft({ runMode: 'linux' }))
    ).rejects.toThrow(/not available on macos/);
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
    expect(renamed.autoNamed).toBe(false);
    await expect(store.update(created.id, { name: '' })).rejects.toThrow(/name is required/);
    expect((await store.get(created.id))?.name).toBe('Renamed');
  });

  it('keeps automatic rename provenance when the auto-renamer supplies it explicitly', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());

    const renamed = await store.update(created.id, {
      name: 'generated-title',
      autoNamed: true
    });

    expect(renamed.autoNamed).toBe(true);
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

  it('binds a Session Source with optimistic entity versioning', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());

    const bound = await store.bindSource(created.id, {
      kind: 'existing-checkout',
      checkoutId: '11111111-1111-4111-8111-111111111111',
      adopted: true
    }, 1);

    expect(bound).toMatchObject({
      version: 2,
      source: {
        kind: 'existing-checkout',
        checkoutId: '11111111-1111-4111-8111-111111111111',
        adopted: true
      }
    });
    await expect(store.bindSource(created.id, {
      kind: 'existing-checkout',
      checkoutId: '22222222-2222-4222-8222-222222222222',
      adopted: true
    }, 1)).rejects.toMatchObject({ code: 'session_version_conflict' });
    expect((await store.get(created.id))?.source).toEqual(bound.source);
  });

  it('creates a preallocated placement Session idempotently and rejects a conflicting retry', async () => {
    const store = new SessionStore(storePath);
    const id = '11111111-1111-4111-8111-111111111111';
    const draft = standardDraft({
      source: {
        kind: 'workspace-location',
        checkoutId: '22222222-2222-4222-8222-222222222222'
      }
    });

    const created = await store.createWithId(id, draft);
    const retried = await store.createWithId(id, draft);

    expect(retried).toEqual(created);
    await expect(store.createWithId(id, { ...draft, name: 'Different' }))
      .rejects.toThrow('different placement intent');
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

  it('tracks new Codex sessions as empty until the first submitted command', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create({
      name: 'Codex',
      cwd: '/x',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });

    expect(created.hasUserInput).toBe(false);
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

  it('migrates legacy records to entity version 1 without guessing a Session Source', async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        sessions: [{
          id: 'legacy',
          name: 'Legacy',
          cwd: '/repo',
          runMode: 'linux',
          launch: { type: 'terminal', shell: 'auto' },
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-01-01T00:00:00.000Z'
        }]
      }),
      'utf8'
    );

    const store = new SessionStore(storePath);
    expect(await store.get('legacy')).toMatchObject({ version: 1 });
    expect((await store.get('legacy'))?.source).toBeUndefined();
    expect(JSON.parse(await fs.readFile(storePath, 'utf8'))).toMatchObject({ version: 2 });
  });
});
