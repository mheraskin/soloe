'use strict';

/**
 * Dependencies are installed (and node-pty is rebuilt for Electron) by the
 * package.json postinstall step. Returning false tells electron-builder that
 * runtime modules are copied explicitly by `extraResources`, avoiding a flaky
 * dependency-tree collector while preserving the platform-native node-pty binary.
 */
module.exports = async function beforeBuild() {
  return false;
};
