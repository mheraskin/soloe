import * as pty from 'node-pty';
import type { PtyProcess, PtyProcessFactory, PtyProcessSpawnOptions } from './PtyProcess.js';

export class NodePtyProcessFactory implements PtyProcessFactory {
  readonly outputIsPrebatched = false;

  spawn(options: PtyProcessSpawnOptions): PtyProcess {
    return pty.spawn(options.spec.file, options.spec.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.spec.cwd,
      env: options.env,
      useConpty: process.platform === 'win32'
    } as pty.IPtyForkOptions);
  }
}
