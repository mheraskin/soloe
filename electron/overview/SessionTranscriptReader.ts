import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  OverviewProvider,
  SessionTranscript,
  SessionTranscriptTurn,
  TranscriptWatermark,
  WorktreeSessionRef
} from '@shared/types/overview.js';
import type { RunMode } from '@shared/types/sessions.js';
import { posixToWslUnc, resolveWslHome } from '../runtime/wsl-paths.js';

export interface SessionScope {
  runMode?: RunMode;
  wslDistro?: string;
}

const TURN_TEXT_MAX = 16_000;

export interface SessionTranscriptReaderOptions {
  homeDir?: string;
}

export class SessionTranscriptReader {
  private readonly homeDir: string;

  constructor(opts: SessionTranscriptReaderOptions = {}) {
    this.homeDir = opts.homeDir ?? os.homedir();
  }

  // Resolves the .claude/projects and .codex/sessions roots. In WSL mode the
  // agents wrote those files inside WSL ($HOME/.claude/...), not under the
  // Windows user profile, so we point at \\wsl.localhost\<distro>\... — Windows
  // fs APIs read those UNC paths natively. Non-WSL falls back to os.homedir().
  private async resolveDirs(scope?: SessionScope): Promise<{
    claudeProjectsDir: string;
    codexSessionsDir: string;
  }> {
    if (scope?.runMode === 'wsl') {
      const distro = scope.wslDistro ?? 'Ubuntu';
      const wslHome = await resolveWslHome(distro);
      return {
        claudeProjectsDir: posixToWslUnc(distro, `${wslHome}/.claude/projects`),
        codexSessionsDir: posixToWslUnc(distro, `${wslHome}/.codex/sessions`)
      };
    }
    return {
      claudeProjectsDir: path.join(this.homeDir, '.claude', 'projects'),
      codexSessionsDir: path.join(this.homeDir, '.codex', 'sessions')
    };
  }

  async listClaudeSessionFiles(cwd: string, scope?: SessionScope): Promise<WorktreeSessionRef[]> {
    const dirs = await this.resolveDirs(scope);
    const projectDir = path.join(dirs.claudeProjectsDir, encodeClaudeCwd(cwd));
    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch (err: unknown) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const refs: WorktreeSessionRef[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectDir, name);
      const ref = await this.peekClaudeFile(file);
      if (ref) refs.push(ref);
    }
    refs.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    return refs;
  }

  async listCodexSessionFiles(cwd: string, scope?: SessionScope): Promise<WorktreeSessionRef[]> {
    const dirs = await this.resolveDirs(scope);
    const files = await listJsonlFilesRecursive(dirs.codexSessionsDir);
    const refs: WorktreeSessionRef[] = [];
    for (const file of files) {
      const ref = await this.peekCodexFile(file, cwd);
      if (ref) refs.push(ref);
    }
    refs.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    return refs;
  }

  async listAllSessions(cwd: string, scope?: SessionScope): Promise<WorktreeSessionRef[]> {
    const [claude, codex] = await Promise.all([
      this.listClaudeSessionFiles(cwd, scope),
      this.listCodexSessionFiles(cwd, scope)
    ]);
    return [...claude, ...codex].sort(
      (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')
    );
  }

  async readTranscript(ref: WorktreeSessionRef): Promise<SessionTranscript> {
    if (ref.provider === 'claude_code') {
      return readClaudeTranscript(ref.sessionFile);
    }
    return readCodexTranscript(ref.sessionFile);
  }

  private async peekClaudeFile(file: string): Promise<WorktreeSessionRef | null> {
    const stat = await safeStat(file);
    if (!stat) return null;
    const lines = await readLines(file);
    if (lines.length === 0) return null;
    let sessionId = path.basename(file, '.jsonl');
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let lastUuid = '';
    for (const line of lines) {
      const rec = parseJsonLine(line);
      if (!rec) continue;
      if (typeof rec['sessionId'] === 'string' && !sessionId) {
        sessionId = rec['sessionId'] as string;
      }
      if (typeof rec['timestamp'] === 'string') {
        if (!startedAt) startedAt = rec['timestamp'] as string;
        endedAt = rec['timestamp'] as string;
      }
      if (typeof rec['uuid'] === 'string') {
        lastUuid = rec['uuid'] as string;
      }
    }
    return {
      provider: 'claude_code',
      sessionFile: file,
      sessionId,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      watermark: {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        lastRecordKey: lastUuid || `${stat.mtimeMs}:${stat.size}`
      }
    };
  }

  private async peekCodexFile(
    file: string,
    expectedCwd: string
  ): Promise<WorktreeSessionRef | null> {
    const stat = await safeStat(file);
    if (!stat) return null;
    const lines = await readLines(file);
    if (lines.length === 0) return null;
    const meta = parseJsonLine(lines[0] ?? '');
    if (!meta || meta['type'] !== 'session_meta') return null;
    const payload = meta['payload'] as Record<string, unknown> | undefined;
    if (!payload) return null;
    const cwd = payload['cwd'];
    if (typeof cwd !== 'string' || !pathsEqual(cwd, expectedCwd)) return null;
    const sessionId = typeof payload['id'] === 'string' ? (payload['id'] as string) : path.basename(file, '.jsonl');
    const startedAt = typeof payload['timestamp'] === 'string' ? (payload['timestamp'] as string) : undefined;
    let endedAt: string | undefined = startedAt;
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = parseJsonLine(lines[i] ?? '');
      if (rec && typeof rec['timestamp'] === 'string') {
        endedAt = rec['timestamp'] as string;
        break;
      }
    }
    return {
      provider: 'codex',
      sessionFile: file,
      sessionId,
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      watermark: {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        lastRecordKey: `${stat.mtimeMs}:${stat.size}`
      }
    };
  }
}

async function readClaudeTranscript(file: string): Promise<SessionTranscript> {
  const stat = await fs.stat(file);
  const lines = await readLines(file);
  const turns: SessionTranscriptTurn[] = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = '';
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let lastUuid = '';
  let hasCompaction = false;

  for (const line of lines) {
    const rec = parseJsonLine(line);
    if (!rec) continue;
    if (typeof rec['sessionId'] === 'string' && !sessionId) {
      sessionId = rec['sessionId'] as string;
    }
    if (typeof rec['cwd'] === 'string' && !cwd) cwd = rec['cwd'] as string;
    if (typeof rec['timestamp'] === 'string') {
      const ts = rec['timestamp'] as string;
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    if (typeof rec['uuid'] === 'string') lastUuid = rec['uuid'] as string;
    const recordType = rec['type'];

    if (recordType === 'system') {
      const subtype = rec['subtype'];
      if (subtype === 'compact_boundary') {
        hasCompaction = true;
        turns.push({
          role: 'system',
          text: '[context compacted]',
          ...(typeof rec['timestamp'] === 'string' ? { timestamp: rec['timestamp'] as string } : {})
        });
      }
      continue;
    }
    if (recordType === 'user') {
      const message = rec['message'] as Record<string, unknown> | undefined;
      const text = extractTextContent(message?.['content']);
      if (text) {
        turns.push({
          role: 'user',
          text: clip(text),
          ...(typeof rec['timestamp'] === 'string' ? { timestamp: rec['timestamp'] as string } : {})
        });
      }
      continue;
    }
    if (recordType === 'assistant') {
      const message = rec['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      const ts = typeof rec['timestamp'] === 'string' ? (rec['timestamp'] as string) : undefined;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            textParts.push(b['text'] as string);
          } else if (b['type'] === 'tool_use') {
            const toolName = typeof b['name'] === 'string' ? (b['name'] as string) : 'tool';
            const input = b['input'];
            const inputText = summarizeToolInput(toolName, input);
            turns.push({
              role: 'tool',
              text: clip(inputText),
              toolName,
              ...(ts ? { timestamp: ts } : {})
            });
          }
        }
        if (textParts.length > 0) {
          turns.push({
            role: 'assistant',
            text: clip(textParts.join('\n')),
            ...(ts ? { timestamp: ts } : {})
          });
        }
      }
      continue;
    }
  }

  return {
    provider: 'claude_code',
    sessionFile: file,
    sessionId,
    cwd,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    turnCount: turns.length,
    turns,
    hasCompaction,
    watermark: {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastRecordKey: lastUuid || `${stat.mtimeMs}:${stat.size}`
    }
  };
}

async function readCodexTranscript(file: string): Promise<SessionTranscript> {
  const stat = await fs.stat(file);
  const lines = await readLines(file);
  const turns: SessionTranscriptTurn[] = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = '';
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let hasCompaction = false;

  for (const line of lines) {
    const rec = parseJsonLine(line);
    if (!rec) continue;
    const ts = typeof rec['timestamp'] === 'string' ? (rec['timestamp'] as string) : undefined;
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    if (rec['type'] === 'session_meta') {
      const payload = rec['payload'] as Record<string, unknown> | undefined;
      if (payload) {
        if (typeof payload['id'] === 'string') sessionId = payload['id'] as string;
        if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string;
      }
      continue;
    }
    if (rec['type'] === 'compacted') {
      hasCompaction = true;
      const payload = rec['payload'] as Record<string, unknown> | undefined;
      const replacement = payload?.['replacement_history'];
      if (Array.isArray(replacement)) {
        for (const item of replacement) {
          const turn = codexResponseItemToTurn(item, ts);
          if (turn) turns.push(turn);
        }
      }
      turns.push({
        role: 'system',
        text: '[context compacted]',
        ...(ts ? { timestamp: ts } : {})
      });
      continue;
    }
    if (rec['type'] === 'response_item') {
      const turn = codexResponseItemToTurn(rec['payload'], ts);
      if (turn) turns.push(turn);
      continue;
    }
    if (rec['type'] === 'event_msg') {
      const payload = rec['payload'] as Record<string, unknown> | undefined;
      const eventType = payload?.['type'];
      if (eventType === 'agent_message') {
        const text = typeof payload?.['message'] === 'string' ? (payload['message'] as string) : '';
        if (text) {
          turns.push({
            role: 'assistant',
            text: clip(text),
            ...(ts ? { timestamp: ts } : {})
          });
        }
      } else if (eventType === 'exec_command_end') {
        const cmd = typeof payload?.['command'] === 'string' ? (payload['command'] as string) : '';
        if (cmd) {
          turns.push({
            role: 'tool',
            text: clip(cmd),
            toolName: 'shell',
            ...(ts ? { timestamp: ts } : {})
          });
        }
      } else if (eventType === 'patch_apply_end') {
        const summary = typeof payload?.['summary'] === 'string'
          ? (payload['summary'] as string)
          : '[patch applied]';
        turns.push({
          role: 'tool',
          text: clip(summary),
          toolName: 'apply_patch',
          ...(ts ? { timestamp: ts } : {})
        });
      }
    }
  }

  return {
    provider: 'codex',
    sessionFile: file,
    sessionId,
    cwd,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    turnCount: turns.length,
    turns,
    hasCompaction,
    watermark: {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastRecordKey: `${stat.mtimeMs}:${stat.size}`
    }
  };
}

function codexResponseItemToTurn(
  payload: unknown,
  ts: string | undefined
): SessionTranscriptTurn | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['type'] !== 'message') return null;
  const role = p['role'];
  if (role !== 'user' && role !== 'assistant' && role !== 'developer') return null;
  if (role === 'developer') return null;
  const content = p['content'];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const txt = b['text'];
    if (typeof txt === 'string') parts.push(txt);
  }
  const text = parts.join('\n').trim();
  if (!text) return null;
  return {
    role,
    text: clip(text),
    ...(ts ? { timestamp: ts } : {})
  };
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return `${toolName}()`;
  if (typeof input !== 'object') return `${toolName}(${String(input)})`;
  const obj = input as Record<string, unknown>;
  const interesting = ['command', 'file_path', 'pattern', 'path', 'query'] as const;
  for (const key of interesting) {
    const val = obj[key];
    if (typeof val === 'string') return `${toolName}: ${val}`;
  }
  try {
    const json = JSON.stringify(obj);
    return `${toolName}: ${json}`;
  } catch {
    return `${toolName}: <unserializable>`;
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b['text'] === 'string') parts.push(b['text'] as string);
      }
    }
    return parts.join('\n');
  }
  return '';
}

async function readLines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function listJsonlFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: { name: string; isDir: boolean; isFile: boolean }[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile()
    }));
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDir) {
      out.push(...(await listJsonlFilesRecursive(full)));
    } else if (entry.isFile && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

async function safeStat(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.stat(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function clip(text: string): string {
  if (text.length <= TURN_TEXT_MAX) return text;
  return text.slice(0, TURN_TEXT_MAX) + `\n…[${text.length - TURN_TEXT_MAX} chars elided]`;
}

export function encodeClaudeCwd(cwd: string): string {
  const normalized = cwd.replace(/\\+/g, '/');
  return normalized.replace(/[/]/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function combineWatermark(refs: WorktreeSessionRef[]): TranscriptWatermark {
  let totalSize = 0;
  let maxMtime = 0;
  const keys: string[] = [];
  for (const ref of refs) {
    totalSize += ref.watermark.size;
    if (ref.watermark.mtimeMs > maxMtime) maxMtime = ref.watermark.mtimeMs;
    keys.push(ref.watermark.lastRecordKey);
  }
  return {
    mtimeMs: maxMtime,
    size: totalSize,
    lastRecordKey: keys.join('|')
  };
}
