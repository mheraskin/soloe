import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = resolve(
  repositoryRoot,
  'apps/desktop-tauri/src-tauri/ghostty-surface-source.json'
);
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const destination = resolve(repositoryRoot, 'target/ghostty-surface');
const archivePath = resolve(destination, metadata.archive);
const artifactRoot = resolve(destination, 'GhosttyKit.xcframework');
const libraryPath = resolve(artifactRoot, 'macos-arm64_x86_64/ghostty-internal.a');
const headerPath = resolve(artifactRoot, 'macos-arm64_x86_64/Headers/ghostty.h');
const stampPath = resolve(destination, '.source.json');
const expectedStamp = JSON.stringify(metadata, null, 2) + '\n';
const requiredSymbols = [
  'GHOSTTY_SURFACE_IO_MANUAL',
  'ghostty_surface_process_output',
  'ghostty_surface_set_renderer_realized'
];

if (isPrepared()) {
  console.log(artifactRoot);
  process.exit(0);
}

if (existsSync(stampPath)) {
  throw new Error(
    `the existing GhosttyKit artifact at ${destination} does not match the pinned source; `
      + 'remove that explicit target directory before preparing it again'
  );
}

mkdirSync(destination, { recursive: true });
if (!existsSync(archivePath)) {
  run('gh', [
    'release',
    'download',
    metadata.releaseTag,
    '--repo',
    metadata.repository,
    '--pattern',
    metadata.archive,
    '--dir',
    destination
  ]);
}

const actualSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
if (actualSha256 !== metadata.sha256) {
  unlinkSync(archivePath);
  throw new Error(
    `GhosttyKit checksum mismatch: received ${actualSha256}, expected ${metadata.sha256}`
  );
}

if (!existsSync(artifactRoot)) {
  run('tar', ['-xzf', archivePath, '-C', destination]);
}
if (!existsSync(libraryPath)) {
  throw new Error(`the pinned GhosttyKit archive did not contain ${libraryPath}`);
}
if (!existsSync(headerPath)) {
  throw new Error(`the pinned GhosttyKit archive did not contain ${headerPath}`);
}
const header = readFileSync(headerPath, 'utf8');
for (const symbol of requiredSymbols) {
  if (!header.includes(symbol)) {
    throw new Error(`the pinned GhosttyKit header does not expose ${symbol}`);
  }
}
writeFileSync(stampPath, expectedStamp);
console.log(artifactRoot);

function isPrepared() {
  if (!existsSync(stampPath) || !existsSync(libraryPath) || !existsSync(headerPath)) return false;
  const header = readFileSync(headerPath, 'utf8');
  return readFileSync(stampPath, 'utf8') === expectedStamp
    && requiredSymbols.every((symbol) => header.includes(symbol));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}
