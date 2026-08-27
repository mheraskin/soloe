import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('macOS CI contract', () => {
  it('validates and packages on native Intel and Apple Silicon runners', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');

    expect(workflow).toContain('runner: macos-15-intel');
    expect(workflow).toContain('command: pnpm package:macos:x64');
    expect(workflow).toContain('runner: macos-latest');
    expect(workflow).toContain('command: pnpm package:macos:arm64');
    expect(workflow).toContain('cargo test --manifest-path apps/tray/src-tauri/Cargo.toml');
    expect(workflow).toContain('target/release/bundle/dmg/*.dmg');
    expect(workflow).not.toContain('release/*-macos-${{ matrix.arch }}.zip');
  });

  it('publishes one unsigned preview installer for each architecture', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');

    expect(workflow).toContain('platform: macos-x64');
    expect(workflow).toContain('platform: macos-arm64');
    expect(workflow).toContain('name: Package platform build');
    expect(workflow).not.toContain('Import Apple Developer certificate');
    expect(workflow).not.toContain('APPLE_SIGNING_IDENTITY');
    expect(workflow).toContain('target/release/bundle/dmg/*.dmg');
    expect(workflow).not.toContain('release/*-macos-*.zip');
  });
});
