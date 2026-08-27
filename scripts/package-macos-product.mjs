import { spawnSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedArch = process.argv[2] ?? process.arch;
const embeddedOutputRoot = path.join(root, 'release', 'embedded');
const electronOutputDirectory = path.join(
  embeddedOutputRoot,
  requestedArch === 'arm64' ? 'mac-arm64' : 'mac'
);
const tauriElectronDirectory = path.join(embeddedOutputRoot, 'mac');
const packagingEnvironment = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
};

if (process.platform !== 'darwin') {
  throw new Error('The macOS product must be built on macOS');
}
if (requestedArch !== 'x64' && requestedArch !== 'arm64') {
  throw new Error(`Unsupported macOS architecture: ${requestedArch}`);
}
if (requestedArch !== process.arch) {
  throw new Error(
    `Build ${requestedArch} on a native ${requestedArch} runner (current process: ${process.arch})`
  );
}

function runTool(name, args, cwd = root) {
  const executable = path.join(root, 'node_modules', '.bin', name);
  runCommand(executable, args, cwd);
}

function runCommand(executable, args, cwd = root) {
  const result = spawnSync(executable, args, {
    cwd,
    env: packagingEnvironment,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} exited with status ${result.status ?? 'unknown'}`);
  }
}

runCommand('pnpm', ['--filter', '@soloe/web', 'build']);
runTool('electron-vite', ['build']);
runTool('electron-builder', [
  '--mac',
  '--dir',
  `--${requestedArch}`,
  '--publish',
  'never',
  '-c.directories.output=release/embedded',
  '-c.appId=com.soloe.ui'
]);
if (electronOutputDirectory !== tauriElectronDirectory) {
  rmSync(tauriElectronDirectory, { recursive: true, force: true });
  renameSync(electronOutputDirectory, tauriElectronDirectory);
}
runTool('tauri', ['build'], path.join(root, 'apps', 'tray'));
