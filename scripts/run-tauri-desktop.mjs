import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationRoot = resolve(repositoryRoot, 'apps/desktop-tauri');
const sourceRoot = resolve(repositoryRoot, 'target/libghostty-source');
const ghosttyKitRoot = resolve(
  repositoryRoot,
  'target/ghostty-surface/GhosttyKit.xcframework'
);
const ghosttyWindowsRoot = resolve(repositoryRoot, 'target/ghostty-windows-source');
const [mode, ...forwardedArguments] = process.argv.slice(2);

if (mode !== 'dev' && mode !== 'build') {
  throw new Error('usage: node scripts/run-tauri-desktop.mjs <dev|build> [...tauri arguments]');
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tauriArguments = [
  'exec',
  'tauri',
  mode,
  ...(mode === 'build' ? ['--no-bundle'] : []),
  ...forwardedArguments
];

if (process.platform === 'darwin') {
  run(process.execPath, [resolve(repositoryRoot, 'scripts/prepare-ghostty-surface.mjs')], {
    cwd: repositoryRoot
  });
  if (!existsSync(ghosttyKitRoot)) {
    throw new Error(`the pinned GhosttyKit artifact was not prepared at ${ghosttyKitRoot}`);
  }
  run(
    pnpm,
    [...tauriArguments, '--features', 'libghostty-macos-surface'],
    {
      cwd: applicationRoot,
      env: { ...process.env, SOLOE_GHOSTTYKIT_DIR: ghosttyKitRoot }
    }
  );
  process.exit(0);
}

if (process.platform === 'win32') {
  run(process.execPath, [resolve(repositoryRoot, 'scripts/prepare-ghostty-windows.mjs')], {
    cwd: repositoryRoot
  });
  run(
    pnpm,
    [...tauriArguments, '--features', 'libghostty-windows-surface'],
    {
      cwd: applicationRoot,
      env: { ...process.env, SOLOE_GHOSTTY_WINDOWS_SOURCE: ghosttyWindowsRoot }
    }
  );
  process.exit(0);
}

if (process.platform !== 'linux') {
  run(pnpm, tauriArguments, { cwd: applicationRoot });
  process.exit(0);
}

run(process.execPath, [resolve(repositoryRoot, 'scripts/prepare-libghostty.mjs')], {
  cwd: repositoryRoot
});

if (!existsSync(sourceRoot)) {
  throw new Error(`the pinned Ghostty source was not prepared at ${sourceRoot}`);
}

const environment = {
  ...process.env,
  SOLOE_LIBGHOSTTY_SOURCE: sourceRoot
};
const nativeArguments = [
  ...tauriArguments,
  '--features',
  'libghostty-linux-prototype'
];

if (isAvailable('zig')) {
  run(pnpm, nativeArguments, { cwd: applicationRoot, env: environment });
} else if (isAvailable('nix')) {
  run('nix', ['shell', 'nixpkgs#zig', '-c', pnpm, ...nativeArguments], {
    cwd: applicationRoot,
    env: environment
  });
} else {
  throw new Error(
    'the default Linux Tauri build requires Zig; install Zig or Nix, or run Tauri directly for xterm fallback'
  );
}

function isAvailable(command) {
  const result = spawnSync(command, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}
