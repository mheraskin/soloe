import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { mergeTerminalEnvironment } from '../../../shared/terminal-environment.js';
import type {
  RuntimeProcess,
  RuntimeProcessFactory
} from './RuntimeProcess.js';

class NodePtyRuntimeProcess extends EventEmitter implements RuntimeProcess {
  readonly pid: number;

  constructor(private readonly process: pty.IPty) {
    super();
    this.pid = process.pid;
    process.onData((data) => this.emit('data', data));
    process.onExit(({ exitCode, signal }) => {
      this.emit('exit', { exitCode, signal: signal ?? null });
    });
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }
}

export class NodePtyRuntimeProcessFactory implements RuntimeProcessFactory {
  spawn(options: Parameters<RuntimeProcessFactory['spawn']>[0]): RuntimeProcess {
    const child = pty.spawn(options.spec.file, options.spec.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.spec.cwd,
      env: mergeTerminalEnvironment(processEnv(), options.spec.env),
      useConpty: process.platform === 'win32'
    });
    return new NodePtyRuntimeProcess(child);
  }
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}
