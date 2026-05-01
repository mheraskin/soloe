import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from './InnerCommand.js';

export interface WindowsRunOptions {
  cwd: string;
  baseEnv: Record<string, string | undefined>;
}

export class WindowsCommandBuilder {
  build(inner: InnerCommand, opts: WindowsRunOptions): SpawnSpec {
    const env = mergeEnv(opts.baseEnv, inner.env);
    return {
      file: inner.executable,
      args: inner.args,
      cwd: opts.cwd,
      env,
      description: describe(inner, opts.cwd)
    };
  }
}

function mergeEnv(
  base: Record<string, string | undefined>,
  overrides: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
  }
  return out;
}

function describe(inner: InnerCommand, cwd: string): string {
  const envParts = Object.entries(inner.env).map(([k, v]) => `${k}=${v}`);
  const cmd = [...envParts, inner.executable, ...inner.args].join(' ');
  return `[${cwd}] ${cmd}`;
}
