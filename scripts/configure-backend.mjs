import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const placement = required(args, 'placement');
if (placement !== 'windows' && placement !== 'wsl') {
  throw new Error('--placement must be "windows" or "wsl"');
}

const dataDirectory = args['data-dir']
  ?? process.env.SOLOE_DATA_DIR
  ?? defaultDataDirectory();
const settingsPath = path.join(dataDirectory, 'settings.json');
const existing = await readJson(settingsPath);
const backend = {
  placement,
  wslDistro: args.distro
    ?? existing.backend?.wslDistro
    ?? 'Ubuntu',
  wslRepositoryRoot: args.root
    ?? existing.backend?.wslRepositoryRoot
    ?? ''
};
if (placement === 'wsl' && !backend.wslRepositoryRoot.startsWith('/')) {
  throw new Error('WSL placement requires --root with an absolute Linux path');
}

const next = { ...existing, backend };
await fs.mkdir(dataDirectory, { recursive: true });
const temporary = `${settingsPath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
await fs.rename(temporary, settingsPath);

process.stdout.write(
  `Soloe backend configured for ${placement === 'wsl' ? `${backend.wslDistro} (${backend.wslRepositoryRoot})` : 'Windows'}.\n`
);
process.stdout.write(`Settings: ${settingsPath}\n`);
process.stdout.write('Stop and start the backend from the tray to apply this placement.\n');

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function defaultDataDirectory() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Soloe');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Soloe');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'soloe');
}
