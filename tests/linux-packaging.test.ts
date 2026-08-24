import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('Linux clipboard packaging', () => {
  it('installs the Wayland clipboard reader during source setup', () => {
    const setup = readFileSync(
      new URL('scripts/setup-linux-electron-sandbox.mjs', root),
      'utf8'
    );

    expect(setup).toContain("spawnSync('wl-paste', ['--version']");
    expect(setup).toContain("['apt-get', 'install', '-y', 'wl-clipboard']");
  });

  it('declares the Wayland clipboard reader as a Debian package dependency', () => {
    const config = readFileSync(new URL('electron-builder.yml', root), 'utf8');

    expect(config).toMatch(/deb:\n(?:  .*\n)*?  depends:\n(?:    - .*\n)*?    - wl-clipboard\n/);
  });
});
