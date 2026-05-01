import * as os from 'node:os';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from './InnerCommand.js';
import { buildPosixCommandLine } from './posix-quote.js';

export interface WslWrapOptions {
  distro: string;
  cwd: string;
  hostCwd?: string;
  loginShell?: boolean;
}

export class WslCommandBuilder {
  static readonly WSL_EXE = 'wsl.exe';

  build(inner: InnerCommand, opts: WslWrapOptions): SpawnSpec {
    const innerLine = buildPosixCommandLine(inner.env, inner.executable, inner.args);
    const bashFlag = opts.loginShell === false ? '-c' : '-lc';
    const args = ['-d', opts.distro, '--cd', opts.cwd, 'bash', bashFlag, innerLine];
    return {
      file: WslCommandBuilder.WSL_EXE,
      args,
      cwd: opts.hostCwd ?? defaultHostCwd(),
      env: {},
      description: `wsl.exe -d ${opts.distro} --cd ${opts.cwd} bash ${bashFlag} ${innerLine}`
    };
  }
}

function defaultHostCwd(): string {
  return process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir();
}
