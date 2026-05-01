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
    kind: 'standard_terminal',
    name: 'My Session',
    cwd: '/home/me/proj',
    runMode: 'windows',
    shell: 'bash',
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
      store.create(standardDraft({ shell: 'custom' }))
    ).rejects.toThrow(/command is required/);
  });

  it('rejects claude resume_by_name without claudeSessionName', async () => {
    const store = new SessionStore(storePath);
    const draft: SessionDraft = {
      kind: 'claude_code',
      name: 'Claude',
      cwd: '/x',
      runMode: 'windows',
      resumeMode: 'resume_by_name'
    };
    await expect(store.create(draft)).rejects.toThrow(/claudeSessionName is required/);
  });

  it('rejects codex resume_by_id without codexSessionId', async () => {
    const store = new SessionStore(storePath);
    const draft: SessionDraft = {
      kind: 'codex',
      name: 'Codex',
      cwd: '/x',
      runMode: 'windows',
      resumeMode: 'resume_by_id'
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

  it('deletes a session and errors on a second delete', async () => {
    const store = new SessionStore(storePath);
    const created = await store.create(standardDraft());
    await store.delete(created.id);
    expect(await store.list()).toHaveLength(0);
    await expect(store.delete(created.id)).rejects.toThrow(/not found/);
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
});
