import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

function icnsEntry(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(data.length + header.length, 4);
  return Buffer.concat([header, data]);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${command} exited with ${result.status}`
    );
  }
}

function createMacosIcns(source, destination, temporaryDirectory) {
  const icon512Path = join(temporaryDirectory, 'icon-512.png');
  run('sips', ['-z', '512', '512', source, '--out', icon512Path]);
  const entries = [
    icnsEntry('ic09', readFileSync(icon512Path)),
    icnsEntry('ic10', readFileSync(source))
  ];
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + header.length, 4);
  writeFileSync(destination, Buffer.concat([header, body]));
}

export function generateMacosIcon() {
  const buildDirectory = join(repositoryRoot, 'build');
  const sourcePath = join(buildDirectory, 'icon.png');
  const pngPath = join(buildDirectory, 'icon-macos.png');
  const icnsPath = join(buildDirectory, 'icon-macos.icns');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'soloe-macos-icon-'));

  try {
    const rendererPath = join(temporaryDirectory, 'pad-macos-icon');
    run('clang', [
      '-fobjc-arc',
      '-framework',
      'AppKit',
      join(scriptDirectory, 'pad-macos-icon.m'),
      '-o',
      rendererPath
    ]);
    run(rendererPath, [sourcePath, pngPath]);
    createMacosIcns(pngPath, icnsPath, temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateMacosIcon();
  console.log('generated build/icon-macos.png and build/icon-macos.icns');
}
