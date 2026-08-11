import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OverviewWatermark } from '@shared/types/overview.js';
import {
  SummaryCacheStore,
  fingerprintWatermark,
  watermarksMatch,
  type CachedOverviewEntry
} from './SummaryCacheStore.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const watermark: OverviewWatermark = {
  scopeKey: 'scope',
  evidenceFingerprint: 'evidence',
  headSha: 'head',
  dirtyHash: 'dirty',
  perSession: [
    {
      sessionFile: '/one.jsonl', displayName: 'One',
      mtimeMs: 1, size: 10, lastRecordKey: 'one:1'
    },
    {
      sessionFile: '/two.jsonl', displayName: 'Two',
      mtimeMs: 2, size: 20, lastRecordKey: 'two:2'
    }
  ]
};

describe('overview watermark identity', () => {
  it('treats session order and display names as prompt-significant', () => {
    const reversed = { ...watermark, perSession: [...watermark.perSession].reverse() };
    const renamed = {
      ...watermark,
      perSession: watermark.perSession.map((session, index) =>
        index === 0 ? { ...session, displayName: 'Renamed' } : session)
    };

    expect(watermarksMatch(watermark, reversed)).toBe(false);
    expect(watermarksMatch(watermark, renamed)).toBe(false);
    expect(fingerprintWatermark(watermark)).not.toBe(fingerprintWatermark(reversed));
  });

  it('persists independent summaries for identical paths in different WSL distros', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-summary-identity-'));
    scratch.push(dir);
    const file = path.join(dir, 'summaries.json');
    const store = new SummaryCacheStore(file);
    const makeEntry = (distro: string, text: string): CachedOverviewEntry => ({
      worktreeCwd: '/home/me/repo',
      runMode: 'wsl',
      wslDistro: distro,
      text,
      generatedAt: '2026-07-14T00:00:00.000Z',
      generatedBy: { provider: 'codex', model: 'gpt-5.4' },
      watermark: { ...watermark, scopeKey: distro },
      sources: { sessionCount: 0, totalTurns: 0, providers: [], approxInputTokens: 0 }
    });
    await store.set(makeEntry('Ubuntu', 'ubuntu overview'));
    await store.set(makeEntry('Debian', 'debian overview'));

    const reloaded = new SummaryCacheStore(file);
    await expect(reloaded.get('/home/me/repo', {
      runMode: 'wsl', wslDistro: 'Ubuntu'
    })).resolves.toMatchObject({ text: 'ubuntu overview' });
    await expect(reloaded.get('/home/me/repo', {
      runMode: 'wsl', wslDistro: 'Debian'
    })).resolves.toMatchObject({ text: 'debian overview' });
  });

  it('invalidates on transcript metadata and evidence changes', () => {
    const resized = {
      ...watermark,
      perSession: [{ ...watermark.perSession[0]!, size: 11 }, watermark.perSession[1]!]
    };
    const changedEvidence = { ...watermark, evidenceFingerprint: 'new evidence' };

    expect(watermarksMatch(watermark, resized)).toBe(false);
    expect(watermarksMatch(watermark, changedEvidence)).toBe(false);
  });
});
