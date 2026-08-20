import * as os from 'node:os';
import * as path from 'node:path';
import { mergeTerminalEnvironment } from '@shared/terminal-environment.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from './InnerCommand.js';

export interface NativeRunOptions {
  cwd: string;
  baseEnv: Record<string, string | undefined>;
}

export class NativeCommandBuilder {
  build(inner: InnerCommand, opts: NativeRunOptions): SpawnSpec {
    const env = mergeTerminalEnvironment(opts.baseEnv, inner.env);
    const cwd = expandHome(opts.cwd);
    return {
      file: inner.executable,
      args: inner.args,
      cwd,
      env,
      description: describe(inner, cwd)
    };
  }
}

// Kept as a source-compatible alias for extensions and older tests. The
// implementation is host-native and is used by both Windows and Linux.
export class WindowsCommandBuilder extends NativeCommandBuilder {}

function expandHome(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    return path.join(os.homedir(), cwd.slice(2));
  }
  return cwd;
}

function describe(inner: InnerCommand, cwd: string): string {
  const envParts = Object.entries(inner.env).map(([k, v]) => `${k}=${v}`);
  const cmd = [...envParts, inner.executable, ...inner.args].join(' ');
  return `[${cwd}] ${cmd}`;
}
