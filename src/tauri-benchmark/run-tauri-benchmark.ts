import type { TauriSpikeInfo, TauriTerminalClient, TauriUsageSnapshot } from './tauri-terminal-client';

const TERMINAL_COUNTS = [5, 10, 20];
const OUTPUT_BYTES = 256 * 1024;
const USAGE_SAMPLES = 3;
const USAGE_INTERVAL_MS = 1100;
const IDLE_SETTLE_MS = 3000;

interface RunningTerminal {
  terminalId: string;
  sessionId: string;
}

export async function runTauriBenchmark(
  client: TauriTerminalClient,
  info: TauriSpikeInfo,
  progress: (message: string) => void
): Promise<unknown> {
  const startupMs = info.benchmarkStartedAtMs === null
    ? null
    : round(Date.now() - info.benchmarkStartedAtMs);
  progress('benchmark · settling idle');
  await delay(IDLE_SETTLE_MS);
  const idleUsage = await sampleUsage(client);
  const scenarios = [];

  for (const terminalCount of TERMINAL_COUNTS) {
    progress(`benchmark · ${terminalCount} terminals`);
    scenarios.push(await runScenario(client, info, terminalCount));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    shell: 'tauri',
    host: {
      platform: info.platform,
      userAgent: navigator.userAgent,
      logicalProcessors: navigator.hardwareConcurrency
    },
    config: {
      terminalCounts: TERMINAL_COUNTS,
      outputBytesPerTerminal: OUTPUT_BYTES,
      usageSamples: USAGE_SAMPLES,
      usageIntervalMs: USAGE_INTERVAL_MS,
      idleSettleMs: IDLE_SETTLE_MS,
      paintsXterm: false
    },
    startup: { mountedMs: startupMs },
    idle: { usageSamples: idleUsage, summary: summarizeUsage(idleUsage) },
    terminals: scenarios
  };
}

async function runScenario(
  client: TauriTerminalClient,
  info: TauriSpikeInfo,
  terminalCount: number
): Promise<unknown> {
  const terminals: RunningTerminal[] = [];
  const byteCounts = new Map<string, number>();
  const tails = new Map<string, string>();
  const decoders = new Map<string, TextDecoder>();
  const waiters = new Map<string, {
    marker: string;
    startedAt: number;
    resolve: (latency: number) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const cleanups: Array<() => void> = [];

  const waitForMarker = (terminalId: string, marker: string, startedAt: number) =>
    new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(terminalId);
        reject(new Error(`timed out waiting for marker on ${terminalId}`));
      }, 15_000);
      waiters.set(terminalId, { marker, startedAt, resolve, reject, timer });
    });

  try {
    const spawnStartedAt = performance.now();
    for (let index = 0; index < terminalCount; index += 1) {
      const terminalId = `tauri-bench-${terminalCount}-${crypto.randomUUID()}`;
      const sessionId = `tauri-session-${terminalCount}-${index}-${crypto.randomUUID()}`;
      decoders.set(terminalId, new TextDecoder());
      cleanups.push(client.onOutput(terminalId, (data) => {
        byteCounts.set(terminalId, (byteCounts.get(terminalId) ?? 0) + data.byteLength);
        const text = decoders.get(terminalId)?.decode(data, { stream: true }) ?? '';
        const tail = `${tails.get(terminalId) ?? ''}${text}`.slice(-8192);
        tails.set(terminalId, tail);
        const waiter = waiters.get(terminalId);
        if (waiter && tail.includes(waiter.marker)) {
          clearTimeout(waiter.timer);
          waiters.delete(terminalId);
          waiter.resolve(performance.now() - waiter.startedAt);
        }
      }));
      await client.start({
        terminalId,
        sessionId,
        file: info.shell,
        args: shellArgs(info.platform),
        cwd: info.cwd,
        env: {},
        cols: 80,
        rows: 24
      });
      terminals.push({ terminalId, sessionId });
    }
    const spawnDurationMs = performance.now() - spawnStartedAt;
    await delay(250);

    const inputLatencyMs = await Promise.all(terminals.map(async (terminal, index) => {
      const value = `latency-${index}-${crypto.randomUUID()}`;
      const marker = `\u001e${value}\u001f`;
      const startedAt = performance.now();
      const observed = waitForMarker(terminal.terminalId, marker, startedAt);
      await client.input(terminal.terminalId, markerCommand(info.platform, value));
      return observed;
    }));

    await delay(USAGE_INTERVAL_MS);
    const usageSamples = await sampleUsage(client);
    const beforeBytes = sumBytes(terminals, byteCounts);
    const frameGaps: number[] = [];
    let monitoringFrames = true;
    let previousFrame = performance.now();
    const frameMonitor = new Promise<void>((resolve) => {
      const frame = (timestamp: number) => {
        frameGaps.push(timestamp - previousFrame);
        previousFrame = timestamp;
        if (monitoringFrames) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });

    const outputStartedAt = performance.now();
    await Promise.all(terminals.map(async (terminal, index) => {
      const value = `throughput-${index}-${crypto.randomUUID()}`;
      const marker = `\u001e${value}\u001f`;
      const observed = waitForMarker(terminal.terminalId, marker, outputStartedAt);
      await client.input(
        terminal.terminalId,
        throughputCommand(info.platform, value)
      );
      await observed;
    }));
    const outputDurationMs = performance.now() - outputStartedAt;
    monitoringFrames = false;
    await frameMonitor;
    const observedBytes = sumBytes(terminals, byteCounts) - beforeBytes;
    const sortedFrameGaps = [...frameGaps].sort((left, right) => left - right);

    const shutdownStartedAt = performance.now();
    await Promise.all(terminals.map((terminal) => client.stop(terminal.terminalId)));
    await delay(100);

    return {
      terminalCount,
      spawnDurationMs: round(spawnDurationMs),
      inputLatencyMs: inputLatencyMs.map(round),
      inputLatency: summarize(inputLatencyMs),
      usageSamples,
      usageSummary: summarizeUsage(usageSamples),
      output: {
        configuredBytes: OUTPUT_BYTES * terminalCount,
        observedBytes,
        durationMs: round(outputDurationMs),
        bytesPerSecond: round(observedBytes / (outputDurationMs / 1000))
      },
      rendererFrames: {
        samples: frameGaps.length,
        medianGapMs: percentile(sortedFrameGaps, 0.5),
        p95GapMs: percentile(sortedFrameGaps, 0.95),
        maxGapMs: round(sortedFrameGaps.at(-1) ?? 0)
      },
      shutdownDurationMs: round(performance.now() - shutdownStartedAt)
    };
  } finally {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('benchmark scenario stopped'));
    }
    for (const cleanup of cleanups) cleanup();
    await Promise.all(terminals.map((terminal) => client.stop(terminal.terminalId).catch(() => {})));
  }
}

async function sampleUsage(client: TauriTerminalClient): Promise<TauriUsageSnapshot[]> {
  const samples: TauriUsageSnapshot[] = [];
  for (let index = 0; index < USAGE_SAMPLES; index += 1) {
    if (index > 0) await delay(USAGE_INTERVAL_MS);
    samples.push(await client.usage());
  }
  return samples;
}

function summarizeUsage(samples: TauriUsageSnapshot[]) {
  return {
    cpuPercent: summarize(samples.map((sample) => sample.cpuPercent)),
    memoryBytes: summarize(samples.map((sample) => sample.memoryBytes)),
    processCount: summarize(samples.map((sample) => sample.processCount))
  };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.map(round),
    min: round(sorted[0] ?? 0),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index] ?? 0);
}

function sumBytes(terminals: RunningTerminal[], byteCounts: Map<string, number>): number {
  return terminals.reduce((sum, terminal) => sum + (byteCounts.get(terminal.terminalId) ?? 0), 0);
}

function shellArgs(platform: string): string[] {
  return platform === 'windows' ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc'];
}

function markerCommand(platform: string, value: string): string {
  return platform === 'windows'
    ? `[Console]::Write(([char]30) + '${value}' + ([char]31) + "\`n")\r\n`
    : `printf '\\036%s\\037\\n' '${value}'\n`;
}

function throughputCommand(platform: string, value: string): string {
  return platform === 'windows'
    ? `[Console]::Write(('x' * ${OUTPUT_BYTES}) + ([char]30) + '${value}' + ([char]31) + "\`n")\r\n`
    : `yes x | head -c ${OUTPUT_BYTES}; printf '\\036%s\\037\\n' '${value}'\n`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
