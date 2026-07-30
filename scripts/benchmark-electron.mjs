import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const root = path.resolve(import.meta.dirname, '..');
const scratchRoot = process.platform === 'linux' && os.tmpdir().startsWith('/mnt/')
  ? '/tmp'
  : os.tmpdir();
const config = parseArgs(process.argv.slice(2));

async function main() {
  if (config.terminalBackend === 'rust') {
    await fs.access(config.sidecarPath).catch(() => {
      throw new Error(
        `Rust terminal sidecar not found at ${config.sidecarPath}; run pnpm build:rust first`
      );
    });
  }
  const startupSamples = [];
  let primary;
  try {
    primary = await launchSoloe();
    startupSamples.push(primary.startupMs);
    const benchmark = await primary.cdp.evaluate(
      `(${runRendererBenchmark.toString()})(${JSON.stringify(config)})`,
      { awaitPromise: true }
    );

    await primary.close();
    primary = undefined;

    for (let index = 1; index < config.startupIterations; index += 1) {
      const instance = await launchSoloe();
      startupSamples.push(instance.startupMs);
      await instance.close();
    }

    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        node: process.version,
        electron: benchmark.environment.electron,
        userAgent: benchmark.environment.userAgent
      },
      config: {
        terminalBackend: config.terminalBackend,
        sidecarPath: config.terminalBackend === 'rust' ? config.sidecarPath : null,
        startupIterations: config.startupIterations,
        terminalCounts: config.terminalCounts,
        outputBytesPerTerminal: config.outputBytes,
        usageSamples: config.usageSamples,
        usageIntervalMs: config.usageIntervalMs,
        idleSettleMs: config.idleSettleMs
      },
      startup: summarize(startupSamples),
      idle: {
        usageSamples: benchmark.idleUsage,
        summary: summarizeUsage(benchmark.idleUsage)
      },
      terminals: benchmark.scenarios.map((scenario) => ({
        ...scenario,
        inputLatency: summarize(scenario.inputLatencyMs),
        usageSummary: summarizeUsage(scenario.usageSamples)
      }))
    };

    const outputPath = path.resolve(root, config.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`Benchmark written to ${outputPath}\n`);
  } finally {
    await primary?.close().catch(() => {});
  }
}

function parseArgs(args) {
  const values = new Map();
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Expected --name=value, received ${arg}`);
    values.set(match[1], match[2]);
  }

  const startupIterations = integer(values.get('startup-iterations') ?? '3', 'startup-iterations');
  const terminalCounts = (values.get('terminal-counts') ?? '5,10,20')
    .split(',')
    .map((value) => integer(value, 'terminal-counts'));
  const outputBytes = integer(values.get('output-bytes') ?? '262144', 'output-bytes');
  const usageSamples = integer(values.get('usage-samples') ?? '3', 'usage-samples');
  const usageIntervalMs = integer(values.get('usage-interval-ms') ?? '1100', 'usage-interval-ms');
  const idleSettleMs = integer(values.get('idle-settle-ms') ?? '3000', 'idle-settle-ms');
  const terminalBackend = values.get('terminal-backend') ?? 'node';
  const timestamp = new Date().toISOString().replaceAll(':', '-');

  if (terminalCounts.length === 0 || terminalCounts.some((value) => value > 20)) {
    throw new Error('terminal-counts must contain values between 1 and 20');
  }
  if (terminalBackend !== 'node' && terminalBackend !== 'rust') {
    throw new Error('terminal-backend must be node or rust');
  }
  const sidecarFilename = process.platform === 'win32'
    ? 'soloe-terminal-sidecar.exe'
    : 'soloe-terminal-sidecar';

  return {
    terminalBackend,
    sidecarPath: path.resolve(values.get('sidecar-path') ?? path.join(root, 'target', 'release', sidecarFilename)),
    startupIterations,
    terminalCounts,
    outputBytes,
    usageSamples,
    usageIntervalMs,
    idleSettleMs,
    output: values.get('output') ?? `benchmarks/results/electron-${terminalBackend}-${timestamp}.json`,
    cwd: root
  };
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function launchSoloe() {
  const userData = await fs.mkdtemp(path.join(scratchRoot, 'soloe-benchmark-'));
  const port = await availablePort();
  const startedAt = performance.now();
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userData}`,
    root
  ], {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: scratchRoot,
      SOLOE_BENCHMARK: '1',
      SOLOE_TERMINAL_BACKEND: config.terminalBackend,
      ...(config.terminalBackend === 'rust'
        ? { SOLOE_TERMINAL_SIDECAR_PATH: config.sidecarPath }
        : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  capture(child.stdout, logs);
  capture(child.stderr, logs);

  try {
    const target = await waitForPage(port, child, logs);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(async () => {
      const ready = await cdp.evaluate(
        `Boolean(window.soloe && document.visibilityState === 'visible' && performance.getEntriesByName('soloe:renderer-mounted').length)`,
        { awaitPromise: false }
      );
      return ready;
    }, 30_000, 'mounted Soloe renderer');

    return {
      child,
      cdp,
      startupMs: round(performance.now() - startedAt),
      async close() {
        await cdp.close().catch(() => {});
        child.kill('SIGTERM');
        await waitForExit(child, 8_000);
        await fs.rm(userData, { recursive: true, force: true });
      }
    };
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => {});
    await fs.rm(userData, { recursive: true, force: true });
    throw new Error(`${error.message}\nElectron log tail:\n${logs.slice(-30).join('')}`);
  }
}

function capture(stream, logs) {
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    logs.push(chunk);
    if (logs.length > 200) logs.shift();
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Could not allocate a debugging port');
  return port;
}

async function waitForPage(port, child, logs) {
  let lastError;
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited with code ${child.exitCode}:\n${logs.slice(-30).join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Electron page${lastError ? `: ${lastError.message}` : ''}`);
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to DevTools')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('DevTools WebSocket failed'));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Renderer evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await new Promise((resolve) => {
      this.socket.addEventListener('close', resolve, { once: true });
      setTimeout(resolve, 500);
    });
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => {
      child.kill('SIGKILL');
    })
  ]);
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.map(round),
    min: round(sorted[0] ?? 0),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: round(sorted.at(-1) ?? 0)
  };
}

function summarizeUsage(samples) {
  return {
    cpuPercent: summarize(samples.map((sample) => sample.cpuPercent)),
    memoryBytes: summarize(samples.map((sample) => sample.memoryBytes)),
    processCount: summarize(samples.map((sample) => sample.processCount)),
    electronProcessCount: summarize(samples.map((sample) => sample.electronProcessCount)),
    childProcessCount: summarize(samples.map((sample) => sample.childProcessCount))
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRendererBenchmark(options) {
  const api = window.soloe;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const unwrap = async (promise) => {
    const result = await promise;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const usage = async () => unwrap(api.system.usage({ detail: 'summary' }));
  const sampleUsage = async () => {
    const samples = [];
    for (let index = 0; index < options.usageSamples; index += 1) {
      if (index > 0) await sleep(options.usageIntervalMs);
      samples.push(await usage());
    }
    return samples;
  };
  const now = () => performance.now();
  const token = (prefix, index) => `${prefix}-${index}-${crypto.randomUUID()}`;
  const markerCommand = (value) => `printf '\\036%s\\037\\n' '${value}'\n`;
  const throughputCommand = (value) =>
    `yes x | head -c ${options.outputBytes}; printf '\\036%s\\037\\n' '${value}'\n`;

  const platform = await unwrap(api.system.platform());
  const environment = {
    electron: navigator.userAgent.match(/Electron\/([^ ]+)/)?.[1] ?? 'unknown',
    userAgent: navigator.userAgent,
    platform
  };
  await sleep(options.idleSettleMs);
  const idleUsage = await sampleUsage();
  const scenarios = [];

  for (const terminalCount of options.terminalCounts) {
    const sessions = [];
    const terminals = [];
    const tails = new Map();
    const byteCounts = new Map();
    const waiters = new Map();
    const decoder = new TextEncoder();
    const unsubscribe = api.terminal.onOutput((event) => {
      byteCounts.set(event.terminalId, (byteCounts.get(event.terminalId) ?? 0) + decoder.encode(event.data).length);
      const tail = `${tails.get(event.terminalId) ?? ''}${event.data}`.slice(-8192);
      tails.set(event.terminalId, tail);
      const waiter = waiters.get(event.terminalId);
      if (waiter && tail.includes(waiter.marker)) {
        clearTimeout(waiter.timer);
        waiters.delete(event.terminalId);
        waiter.resolve(now() - waiter.startedAt);
      }
    });

    const waitForMarker = (terminalId, marker, startedAt) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(terminalId);
        reject(new Error(`Timed out waiting for terminal marker on ${terminalId}`));
      }, 15_000);
      waiters.set(terminalId, { marker, startedAt, resolve, timer });
    });

    try {
      for (let index = 0; index < terminalCount; index += 1) {
        sessions.push(await unwrap(api.sessions.create({
          name: `Benchmark ${terminalCount}-${index}`,
          cwd: options.cwd,
          runMode: platform.defaultRunMode,
          launch: {
            type: 'terminal',
            shell: 'custom',
            command: '/bin/bash',
            args: ['--noprofile', '--norc']
          }
        })));
      }

      const spawnStartedAt = now();
      for (const session of sessions) {
        const started = await unwrap(api.terminal.start({ sessionId: session.id, cols: 80, rows: 24 }));
        terminals.push(started);
        await unwrap(api.terminal.setOutputDemand({ terminalId: started.terminalId, active: true }));
      }
      const spawnDurationMs = now() - spawnStartedAt;
      await sleep(250);

      const inputLatencyMs = await Promise.all(terminals.map(async (terminal, index) => {
        const value = token('latency', index);
        const marker = `\u001e${value}\u001f`;
        const startedAt = now();
        const observed = waitForMarker(terminal.terminalId, marker, startedAt);
        await unwrap(api.terminal.input({
          terminalId: terminal.terminalId,
          data: markerCommand(value)
        }));
        return observed;
      }));

      await sleep(options.usageIntervalMs);
      const usageSamples = await sampleUsage();
      const beforeBytes = terminals.reduce(
        (sum, terminal) => sum + (byteCounts.get(terminal.terminalId) ?? 0),
        0
      );
      const frameGaps = [];
      let monitoringFrames = true;
      let previousFrame = now();
      const frameMonitor = new Promise((resolve) => {
        const frame = (timestamp) => {
          frameGaps.push(timestamp - previousFrame);
          previousFrame = timestamp;
          if (monitoringFrames) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });

      const outputStartedAt = now();
      await Promise.all(terminals.map(async (terminal, index) => {
        const value = token('throughput', index);
        const marker = `\u001e${value}\u001f`;
        const observed = waitForMarker(terminal.terminalId, marker, outputStartedAt);
        await unwrap(api.terminal.input({
          terminalId: terminal.terminalId,
          data: throughputCommand(value)
        }));
        await observed;
      }));
      const outputDurationMs = now() - outputStartedAt;
      monitoringFrames = false;
      await frameMonitor;
      const afterBytes = terminals.reduce(
        (sum, terminal) => sum + (byteCounts.get(terminal.terminalId) ?? 0),
        0
      );
      const observedBytes = afterBytes - beforeBytes;
      const sortedFrameGaps = [...frameGaps].sort((left, right) => left - right);

      const shutdownStartedAt = now();
      for (const terminal of terminals) {
        await unwrap(api.terminal.setOutputDemand({ terminalId: terminal.terminalId, active: false }));
        await unwrap(api.terminal.stop(terminal.terminalId));
      }
      for (const session of sessions) await unwrap(api.sessions.delete(session.id));

      scenarios.push({
        terminalCount,
        spawnDurationMs,
        inputLatencyMs,
        usageSamples,
        output: {
          configuredBytes: options.outputBytes * terminalCount,
          observedBytes,
          durationMs: outputDurationMs,
          bytesPerSecond: observedBytes / (outputDurationMs / 1000)
        },
        rendererFrames: {
          samples: frameGaps.length,
          medianGapMs: sortedFrameGaps[Math.max(0, Math.ceil(sortedFrameGaps.length * 0.5) - 1)] ?? 0,
          p95GapMs: sortedFrameGaps[Math.max(0, Math.ceil(sortedFrameGaps.length * 0.95) - 1)] ?? 0,
          maxGapMs: sortedFrameGaps.at(-1) ?? 0
        },
        shutdownDurationMs: now() - shutdownStartedAt
      });
    } finally {
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      unsubscribe();
      for (const terminal of terminals) {
        await api.terminal.setOutputDemand({ terminalId: terminal.terminalId, active: false }).catch(() => {});
        await api.terminal.stop(terminal.terminalId).catch(() => {});
      }
      for (const session of sessions) await api.sessions.delete(session.id).catch(() => {});
    }
  }

  return { environment, idleUsage, scenarios };
}

await main();
