import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const values = new Map(process.argv.slice(2).map((argument) => {
  const match = /^--([^=]+)=(.*)$/.exec(argument);
  if (!match) throw new Error(`Expected --name=value, received ${argument}`);
  return [match[1], match[2]];
}));
const timestamp = new Date().toISOString().replaceAll(':', '-');
const outputPath = path.resolve(
  root,
  values.get('output') ?? `benchmarks/results/tauri-rust-${timestamp}.json`
);
const binaryName = process.platform === 'win32' ? 'soloe-tauri-spike.exe' : 'soloe-tauri-spike';
const binaryPath = path.resolve(
  values.get('binary') ?? path.join(root, 'target', 'release', binaryName)
);

await fs.access(binaryPath).catch(() => {
  throw new Error(`Tauri spike binary not found at ${binaryPath}; run pnpm build:tauri first`);
});
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.rm(outputPath, { force: true });

const startedAtMs = Date.now();
const child = spawn(binaryPath, [], {
  cwd: root,
  env: {
    ...process.env,
    SOLOE_TAURI_BENCHMARK_OUTPUT: outputPath,
    SOLOE_TAURI_STARTED_AT_MS: String(startedAtMs)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
capture(child.stdout, logs);
capture(child.stderr, logs);

try {
  await waitForOutput(child, outputPath, 180_000);
  const result = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  result.runner = {
    binaryPath,
    binarySizeBytes: (await fs.stat(binaryPath)).size,
    node: process.version,
    hostPlatform: process.platform,
    hostArch: process.arch,
    hostRelease: os.release()
  };
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`Benchmark written to ${outputPath}\n`);
} catch (error) {
  child.kill('SIGKILL');
  throw new Error(`${error.message}\nTauri log tail:\n${logs.slice(-40).join('')}`);
}

function capture(stream, logs) {
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    logs.push(chunk);
    if (logs.length > 200) logs.shift();
  });
}

async function waitForOutput(child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(output);
      return;
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Tauri exited before producing a result (${child.exitCode ?? child.signalCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for the Tauri benchmark`);
}
