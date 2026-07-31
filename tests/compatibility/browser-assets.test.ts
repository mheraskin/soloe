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

  it('provides an installable standalone manifest with both required icon sizes', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, 'build/manifest.webmanifest'), 'utf8')
    ) as {
      id?: string;
      start_url?: string;
      scope?: string;
      display?: string;
      icons?: Array<{ src: string; sizes: string; purpose?: string }>;
    };

    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone'
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: '/icon-192.png', sizes: '192x192' }),
        expect.objectContaining({ src: '/icon.png', sizes: '512x512' })
      ])
    );
    for (const icon of manifest.icons ?? []) {
      expect(icon.purpose).toContain('maskable');
      await expect(
        access(path.join(repositoryRoot, 'build', icon.src.replace(/^\//, '')))
      ).resolves.toBeUndefined();
    }
  });

  it('registers a service worker without caching authenticated API requests', async () => {
    const [index, main, serviceWorker] = await Promise.all([
      readFile(path.join(repositoryRoot, 'src/index.html'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/main.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'build/sw.js'), 'utf8')
    ]);

    expect(index).toContain('<link rel="apple-touch-icon" href="/icon-192.png" />');
    expect(index).toContain('apple-mobile-web-app-capable');
    expect(main).toContain("navigator.serviceWorker.register('/sw.js', { scope: '/' })");
    expect(serviceWorker).toContain("url.pathname.startsWith('/api/')");
    expect(serviceWorker).toContain("request.method !== 'GET'");
  });
});
