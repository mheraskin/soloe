import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiagnosticsService } from './DiagnosticsService.js';

describe('DiagnosticsService', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-diagnostics-')));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('list: reports missing configured binaries', async () => {
    const service = new DiagnosticsService({
      settings: {
        get: async () => ({
          version: 1,
          appearance: { theme: 'dark', density: 'comfortable' },
          terminal: { fontSize: 13 },
          defaults: { runMode: 'windows', shell: 'auto' },
          binaries: { claude: path.join(tmpRoot, 'missing-claude') }
        })
      } as never,
      projects: { list: async () => [] } as never,
      git: { getDirty: async () => ({ isRepo: false }) } as never,
      crashDir: path.join(tmpRoot, 'crashes')
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'binary.claude',
        severity: 'error',
        action: 'settings'
      })
    ]);
  });

  it('crashLogs: lists crash log summaries newest first', async () => {
    const crashDir = path.join(tmpRoot, 'crashes');
    await fs.mkdir(crashDir);
    await fs.writeFile(path.join(crashDir, 'a.log'), 'a\n', 'utf8');
    await fs.writeFile(path.join(crashDir, 'b.log'), 'b\n', 'utf8');

    const service = new DiagnosticsService({
      settings: { get: async () => ({ binaries: {} }) } as never,
      projects: { list: async () => [] } as never,
      git: { getDirty: async () => ({ isRepo: false }) } as never,
      crashDir
    });

    const logs = await service.crashLogs();
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.fileName).sort()).toEqual(['a.log', 'b.log']);
  });
});
