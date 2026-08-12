import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, 'apps/desktop-tauri/src-tauri/ghostty-surface-source.json'),
    'utf8'
  )
);
const destination = resolve(repositoryRoot, metadata.windowsSourceDirectory);
const windowsPatch = resolve(repositoryRoot, metadata.windowsPatch);
const requiredArtifacts = [
  metadata.windowsDll,
  metadata.windowsImportLibrary,
  metadata.windowsHeader
].map((relativePath) => resolve(destination, relativePath));
const publicRepository = `https://github.com/${metadata.repository}.git`;

if (!existsSync(destination)) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', publicRepository, destination]);
  run('git', ['checkout', '--detach', metadata.revision], { cwd: destination });
}

const currentRevision = run('git', ['rev-parse', 'HEAD'], {
  cwd: destination,
  capture: true
});
if (currentRevision !== metadata.revision) {
  throw new Error(
    `existing Ghostty checkout is ${currentRevision}; expected ${metadata.revision}. `
      + `Remove ${destination} explicitly before preparing it again.`
  );
}

applyPinnedPatch(windowsPatch, destination);

if (!requiredArtifacts.every(existsSync)) {
  if (process.platform !== 'win32') {
    throw new Error(
      `the pinned Windows Ghostty artifacts are absent in ${destination}; `
        + `build preparation must run in Windows with Zig ${metadata.windowsZigVersion}`
    );
  }
  const zigExecutable = resolveWindowsExecutable('zig');
  const zigEnvironment = prependExecutableDirectory(zigExecutable);
  const zigVersion = run(zigExecutable, ['version'], {
    capture: true,
    env: zigEnvironment
  });
  if (zigVersion !== metadata.windowsZigVersion) {
    throw new Error(
      `Windows Ghostty requires Zig ${metadata.windowsZigVersion}; found ${zigVersion}`
    );
  }
  run(zigExecutable, ['build', '-Doptimize=ReleaseFast'], {
    cwd: destination,
    env: zigEnvironment
  });
}

for (const artifact of requiredArtifacts) {
  if (!existsSync(artifact)) {
    throw new Error(`the pinned Ghostty Windows build did not produce ${artifact}`);
  }
}

const header = readFileSync(requiredArtifacts[2], 'utf8');
for (const symbol of [
  'GHOSTTY_PLATFORM_OPENGL',
  'GHOSTTY_SURFACE_IO_MANUAL',
  'ghostty_surface_process_output'
]) {
  if (!header.includes(symbol)) {
    throw new Error(`the pinned Ghostty Windows header does not expose ${symbol}`);
  }
}

console.log(destination);

function applyPinnedPatch(patch, checkout) {
  if (!existsSync(patch)) {
    throw new Error(`the pinned Windows Ghostty patch is missing: ${patch}`);
  }
  const alreadyApplied = spawnSync(
    'git',
    ['apply', '--reverse', '--check', patch],
    { cwd: checkout, encoding: 'utf8', stdio: 'pipe' }
  );
  if (alreadyApplied.status === 0) return;

  run('git', ['apply', '--check', patch], { cwd: checkout });
  run('git', ['apply', patch], { cwd: checkout });
}

function resolveWindowsExecutable(command) {
  const matches = run('where.exe', [command], { capture: true })
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (matches.length === 0) {
    throw new Error(`${command} was not found on PATH`);
  }
  return matches[0];
}

function prependExecutableDirectory(executable) {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  return {
    ...process.env,
    [pathKey]: `${dirname(executable)}${delimiter}${process.env[pathKey] ?? ''}`
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? result.stdout.trim() : '';
}
