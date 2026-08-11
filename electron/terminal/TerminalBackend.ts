import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { NodePtyProcessFactory } from './NodePtyProcessFactory.js';
import type { PtyProcessFactory } from './PtyProcess.js';
import { RustPtyProcessFactory } from './RustPtyProcessFactory.js';

export type TerminalBackendName = 'node' | 'rust';

export interface TerminalBackendOptions {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  log?: (message: string, detail?: unknown) => void;
}

export interface TerminalBackendSelection {
  name: TerminalBackendName;
  processFactory: PtyProcessFactory;
  sidecarPath?: string;
}

export function selectTerminalBackend(options: TerminalBackendOptions): TerminalBackendSelection {
  const env = options.env ?? process.env;
  const requested = env['SOLOE_TERMINAL_BACKEND']?.trim().toLowerCase() || 'node';
  if (requested === 'node') {
    return { name: 'node', processFactory: new NodePtyProcessFactory() };
  }
  if (requested !== 'rust') {
    throw new Error(`Unsupported terminal backend: ${requested}`);
  }

  const sidecarPath = env['SOLOE_TERMINAL_SIDECAR_PATH']?.trim()
    || defaultRustSidecarPath(options);
  const pathExists = options.pathExists ?? existsSync;
  if (!pathExists(sidecarPath)) {
    throw new Error(
      `Rust terminal sidecar not found at ${sidecarPath}. Build it with cargo build --release -p soloe-terminal.`
    );
  }
  return {
    name: 'rust',
    processFactory: new RustPtyProcessFactory({ executablePath: sidecarPath, log: options.log }),
    sidecarPath
  };
}

export function defaultRustSidecarPath(options: TerminalBackendOptions): string {
  const filename = options.platform === 'win32' || (!options.platform && process.platform === 'win32')
    ? 'soloe-terminal-sidecar.exe'
    : 'soloe-terminal-sidecar';
  const root = options.isPackaged ? options.resourcesPath : options.appPath;
  const pathApi = root.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/u.test(root)
    ? path.win32
    : path.posix;
  return options.isPackaged
    ? pathApi.join(root, 'bin', filename)
    : pathApi.join(root, 'target', 'release', filename);
}
