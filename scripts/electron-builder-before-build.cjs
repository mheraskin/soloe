'use strict';

const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * Dependencies are installed (and node-pty is rebuilt for Electron) by the
 * package.json postinstall step. Returning false tells electron-builder that
 * runtime modules are copied explicitly by `extraResources`, avoiding a flaky
 * dependency-tree collector while preserving the platform-native node-pty binary.
 * The hook also builds the platform-native DNS service shipped with Connections.
 */
module.exports = async function beforeBuild() {
  await execFileAsync('cargo', ['build', '--release', '-p', 'soloe-device-dns'], {
    cwd: path.resolve(__dirname, '..')
  });
  const executable = process.platform === 'win32' ? 'soloe-device-dns.exe' : 'soloe-device-dns';
  const outputDirectory = path.resolve(__dirname, '..', 'build', 'device-dns');
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '..', 'target', 'release', executable),
    path.join(outputDirectory, executable)
  );
  return false;
};
