import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = 'ghostty-org/ghostty';
const revision = '426386b8579d5e558aa5d4cfdfb003ad06bc4fc5';
const destination = resolve('target/libghostty-source');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

if (!existsSync(destination)) {
  run('gh', ['repo', 'clone', repository, destination, '--', '--no-checkout']);
  run('git', ['checkout', '--detach', revision], { cwd: destination });
}

const currentRevision = run('git', ['rev-parse', 'HEAD'], {
  cwd: destination,
  capture: true
});
if (currentRevision !== revision) {
  throw new Error(
    `existing Ghostty checkout is ${currentRevision}; expected ${revision}. `
      + `Remove ${destination} explicitly before preparing it again.`
  );
}

console.log(destination);
