import { randomBytes } from 'node:crypto';
import type { Session } from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SpawnSpec, TerminalId } from '@shared/types/terminal.js';
import type { SessionCommandBuilder } from '../sessions/SessionCommandBuilder.js';
import type { PtyProcess, PtyProcessFactory } from '../terminal/PtyProcess.js';

export interface CodexEffectiveConfig {
  approvalPolicy: string | null;
  approvalsReviewer: string | null;
  sandboxMode: string | null;
  config: Record<string, unknown>;
  layers: unknown[] | null;
  origins: Record<string, unknown>;
}

export interface CodexConfigReaderOptions {
  commandBuilder: SessionCommandBuilder;
  processFactory: PtyProcessFactory;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

interface JsonRpcResponse {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class CodexConfigReader {
  private readonly cache = new Map<string, Promise<CodexEffectiveConfig | null>>();
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CodexConfigReaderOptions) {
    this.baseEnv = opts.baseEnv ?? process.env;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  read(
    session: Session,
    binaries?: SettingsBinaries,
    refresh = false
  ): Promise<CodexEffectiveConfig | null> {
    const key = configCacheKey(session, binaries?.codex);
    if (refresh) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.readUncached(session, binaries).then((value) => {
      if (!value) this.cache.delete(key);
      return value;
    });
    this.cache.set(key, pending);
    return pending;
  }

  clear(): void {
    this.cache.clear();
  }

  private async readUncached(
    session: Session,
    binaries?: SettingsBinaries
  ): Promise<CodexEffectiveConfig | null> {
    let spec: SpawnSpec;
    try {
      spec = this.opts.commandBuilder.buildCodexConfigRead(session, {
        baseEnv: this.baseEnv,
        ...(binaries ? { binaries } : {})
      });
    } catch (error) {
      this.opts.log?.('failed to build Codex config reader command', error);
      return null;
    }

    const terminalId = `t-codex-config-${randomBytes(6).toString('hex')}` as TerminalId;
    let proc: PtyProcess;
    try {
      proc = await this.opts.processFactory.spawn({
        terminalId,
        sessionId: session.id,
        spec,
        cols: 80,
        rows: 24,
        env: mergeEnv(this.baseEnv, spec.env)
      });
    } catch (error) {
      this.opts.log?.('failed to start Codex config reader', error);
      return null;
    }
    return this.exchange(proc, session);
  }

  private exchange(proc: PtyProcess, session: Session): Promise<CodexEffectiveConfig | null> {
    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';
      let timer: ReturnType<typeof setTimeout> | null = null;
      let output: { dispose(): void } | null = null;
      let exited: { dispose(): void } | null = null;
      const finish = (value: CodexEffectiveConfig | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        output?.dispose();
        exited?.dispose();
        try { proc.kill(); } catch {}
        resolve(value);
      };
      const handleLine = (line: string): void => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line.trim()) as JsonRpcResponse;
        } catch {
          return;
        }
        if (
          message.id !== 2
          || message.method !== undefined
          || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))
        ) return;
        if (message.error) {
          this.opts.log?.('Codex config/read returned an error', message.error);
          finish(null);
          return;
        }
        finish(parseConfigResponse(message.result));
      };
      output = proc.onData((data) => {
        buffer += data;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/u, '');
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
      });
      exited = proc.onExit((event) => {
        if (settled) return;
        this.opts.log?.('Codex config reader exited before config/read completed', event);
        finish(null);
      });
      timer = setTimeout(() => {
        this.opts.log?.('Codex config reader timed out', { sessionId: session.id });
        finish(null);
      }, this.timeoutMs);

      try {
        writeJson(proc, {
          method: 'initialize',
          id: 1,
          params: {
            clientInfo: {
              name: 'soloe',
              title: 'Soloe',
              version: '1.0.0'
            }
          }
        });
        writeJson(proc, { method: 'initialized', params: {} });
        writeJson(proc, {
          method: 'config/read',
          id: 2,
          params: { cwd: session.cwd, includeLayers: true }
        });
      } catch (error) {
        this.opts.log?.('failed to request Codex config/read', error);
        finish(null);
      }
    });
  }
}

export function codexApprovalsAreAutomatic(config: CodexEffectiveConfig | null): boolean {
  return config?.approvalPolicy === 'never' || config?.approvalsReviewer === 'auto_review';
}

function parseConfigResponse(value: unknown): CodexEffectiveConfig | null {
  if (!isRecord(value) || !isRecord(value.config)) return null;
  const config = value.config;
  return {
    approvalPolicy: stringValue(config.approval_policy),
    approvalsReviewer: stringValue(config.approvals_reviewer),
    sandboxMode: stringValue(config.sandbox_mode),
    config,
    layers: Array.isArray(value.layers) ? value.layers : null,
    origins: isRecord(value.origins) ? value.origins : {}
  };
}

function configCacheKey(session: Session, codexBinary: string | undefined): string {
  const extraArgs = session.launch.type === 'agent' && session.launch.provider === 'codex'
    ? session.launch.extraArgs ?? []
    : [];
  return JSON.stringify([
    session.id,
    session.runMode,
    session.wslDistro ?? null,
    session.cwd,
    codexBinary ?? 'codex',
    extraArgs
  ]);
}

function writeJson(proc: PtyProcess, value: unknown): void {
  proc.write(`${JSON.stringify(value)}\n`);
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') result[key] = value;
  }
  return { ...result, ...overrides };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
