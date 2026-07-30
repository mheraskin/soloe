import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();

describe('browser application assets', () => {
  it('sends the authentication cookie when the browser fetches the PWA manifest', async () => {
    const index = await readFile(path.join(repositoryRoot, 'src/index.html'), 'utf8');

    expect(index).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />'
    );
  });

  it('declares a favicon that exists in the public asset directory', async () => {
    const index = await readFile(path.join(repositoryRoot, 'src/index.html'), 'utf8');

    expect(index).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    await expect(access(path.join(repositoryRoot, 'build/favicon.svg'))).resolves.toBeUndefined();
  });
});
