import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux') {
  console.log('Linux host setup is only required on Linux.');
  process.exit(0);
}

const clipboardReader = spawnSync('wl-paste', ['--version'], { stdio: 'ignore' });
if (clipboardReader.status !== 0) {
  console.log('Installing wl-clipboard for native Claude Code image paste...');
  const result = spawnSync(
    'sudo',
    ['apt-get', 'install', '-y', 'wl-clipboard'],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} else {
  console.log('Wayland clipboard reader is already installed.');
}

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const sandboxPath = join(dirname(electronBinary), 'chrome-sandbox');

const before = await stat(sandboxPath);
const beforeMode = before.mode & 0o7777;

if (before.uid === 0 && beforeMode === 0o4755) {
  console.log(`Electron sandbox is already configured: ${sandboxPath}`);
  process.exit(0);
}

for (const args of [
  ['chown', 'root:root', sandboxPath],
  ['chmod', '4755', sandboxPath]
]) {
  const result = spawnSync('sudo', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const after = await stat(sandboxPath);
const afterMode = after.mode & 0o7777;
if (after.uid !== 0 || afterMode !== 0o4755) {
  throw new Error(`Electron sandbox setup did not produce root:root mode 4755: ${sandboxPath}`);
}

console.log(`Configured Electron sandbox: ${sandboxPath}`);
