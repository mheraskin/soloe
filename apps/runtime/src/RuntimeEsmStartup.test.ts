import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));

describe('Environment Runtime raw Node startup', () => {
  it('loads the headless terminal module through the production ESM loader', () => {
    expect(() => execFileSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(path.join(runtimeDirectory, 'TerminalScreenState.ts'))})`
    ], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
      stdio: 'pipe'
    })).not.toThrow();
  });
});
