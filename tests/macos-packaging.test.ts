import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('macOS package contract', () => {
  it('bundles workspaces and externalizes packaged Electron dependencies', () => {
    const config = readFileSync(new URL('electron.vite.config.ts', root), 'utf8');

    expect(config).toContain('externalizeDeps: false');
    expect(config).toContain("external: ['electron', 'node-pty', 'smol-toml', 'ws']");
  });

  it('embeds separate runtime and application-server entries', () => {
    const config = readFileSync(new URL('electron.vite.config.ts', root), 'utf8');
    const runtimeHost = readFileSync(new URL('electron/runtime-host.ts', root), 'utf8');
    const serverHost = readFileSync(new URL('electron/server-host.ts', root), 'utf8');

    expect(config).toContain(
      "'runtime-host': resolve(__dirname, 'electron/runtime-host.ts')"
    );
    expect(config).toContain(
      "'server-host': resolve(__dirname, 'electron/server-host.ts')"
    );
    expect(runtimeHost).toContain('new RuntimeHost({');
    expect(runtimeHost).toContain('new NodePtyRuntimeProcessFactory()');
    expect(runtimeHost).toContain('writeServiceInfo(dataDirectory');
    expect(serverHost).toContain("import { startServerHost } from '../apps/server/src/ServerHost.js'");
    expect(serverHost).toContain('await startServerHost()');
  });

  it('builds the browser client into the packaged backend payload', () => {
    const packageScript = readFileSync(
      new URL('scripts/package-macos-product.mjs', root),
      'utf8'
    );
    const builderConfig = readFileSync(new URL('electron-builder.yml', root), 'utf8');

    expect(packageScript).toContain("runCommand('pnpm', ['--filter', '@soloe/web', 'build'])");
    expect(builderConfig).toContain('- out/web/**/*');
  });

  it('defines native Intel and Apple Silicon single-product package commands', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts['package:macos:x64']).toBe(
      'node scripts/package-macos-product.mjs x64'
    );
    expect(manifest.scripts['package:macos:arm64']).toBe(
      'node scripts/package-macos-product.mjs arm64'
    );
  });

  it('publishes unsigned macOS preview builds without requiring signing secrets', () => {
    const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');

    expect(workflow).toContain('platform: macos-x64');
    expect(workflow).toContain('platform: macos-arm64');
    expect(workflow).toContain('name: Package platform build');
    expect(workflow).not.toContain('MACOS_CERTIFICATE');
    expect(workflow).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
  });

  it('ships one Soloe app with the Electron UI embedded inside it', () => {
    const trayConfig = JSON.parse(
      readFileSync(new URL('apps/tray/src-tauri/tauri.conf.json', root), 'utf8')
    ) as {
      productName: string;
      identifier: string;
      bundle: { macOS?: { files?: Record<string, string>; signingIdentity?: string } };
    };
    const packageScript = readFileSync(
      new URL('scripts/package-macos-product.mjs', root),
      'utf8'
    );

    expect(trayConfig.productName).toBe('Soloe');
    expect(trayConfig.identifier).toBe('com.soloe.desktop');
    expect(trayConfig.bundle.macOS?.files).toEqual({
      'Resources/Soloe.app': '../../../release/embedded/mac/Soloe.app'
    });
    expect(trayConfig.bundle.macOS?.signingIdentity).toBe('-');
    expect(packageScript).toContain("'--dir'");
    expect(packageScript).toContain("'-c.appId=com.soloe.ui'");
    expect(packageScript).toContain("requestedArch === 'arm64' ? 'mac-arm64' : 'mac'");
    expect(packageScript).toContain(
      'renameSync(electronOutputDirectory, tauriElectronDirectory)'
    );
    expect(packageScript).toContain("runTool('tauri', ['build']");
  });

  it('keeps the embedded Electron UI signed-ready with macOS entitlements', () => {
    const config = readFileSync(new URL('electron-builder.yml', root), 'utf8');

    expect(config).toMatch(/mac:\n(?:.|\n)*?icon: build\/icon-macos\.icns/);
    expect(config).toMatch(/hardenedRuntime: true/);
    expect(config).toMatch(/entitlements: build\/entitlements\.mac\.plist/);
    expect(existsSync(new URL('build/icon-macos.icns', root))).toBe(true);
    expect(existsSync(new URL('build/icon-macos.png', root))).toBe(true);
  });
});
