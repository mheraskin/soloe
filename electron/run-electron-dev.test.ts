import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe('macOS Electron development bundle preparation', () => {
  it('normalizes an expanded versioned framework into the canonical symlink layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soloe-electron-framework-'));
    temporaryDirectories.push(root);
    const framework = join(root, 'Example.framework');
    const versionA = join(framework, 'Versions', 'A');
    await mkdir(join(versionA, 'Resources'), { recursive: true });
    await writeFile(join(versionA, 'Example'), 'versioned');
    await mkdir(join(framework, 'Versions', 'Current', 'Resources'), { recursive: true });
    await writeFile(join(framework, 'Versions', 'Current', 'Example'), 'expanded-current');
    await mkdir(join(framework, 'Resources'), { recursive: true });
    await writeFile(join(framework, 'Example'), 'expanded-top-level');

    // @ts-expect-error The launcher is intentionally plain Node ESM.
    const launcher = await import('../scripts/run-electron-dev.mjs') as {
      normalizeMacosFrameworkBundle(path: string): Promise<void>;
    };
    await launcher.normalizeMacosFrameworkBundle(framework);

    expect((await lstat(join(framework, 'Versions', 'Current'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(framework, 'Versions', 'Current'))).toBe('A');
    expect((await lstat(join(framework, 'Example'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(framework, 'Example'))).toBe('Versions/Current/Example');
    expect((await lstat(join(framework, 'Resources'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(framework, 'Resources'))).toBe('Versions/Current/Resources');
  });
});
