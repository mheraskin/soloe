import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type {
  ModelProvider,
  ModelSelection,
  Settings,
  SettingsBinaries
} from '@shared/types/settings.js';
import type { Session, SessionId } from '@shared/types/sessions.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import { buildWslAgentLine } from '../sessions/SessionCommandBuilder.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { SettingsStore } from '../settings/SettingsStore.js';
import type { Notifier } from '../notify/Notifier.js';

export interface AutoRenameServiceOptions {
  sessionStore: SessionStore;
  settings: SettingsStore;
  notifier?: Notifier;
  onSessionChange?: (session: Session) => void;
  log?: (message: string, detail?: unknown) => void;
  // Override binary spawn in tests; production calls runProcess.
  spawnImpl?: typeof spawn;
}

interface RenameInputs {
  sessionId: SessionId;
  firstPrompt: string;
}

const RENAME_TIMEOUT_MS = 20_000;
const NAME_MAX_LENGTH = 60;
const PROMPT_MAX_LENGTH = 1500;

const NAMING_INSTRUCTION =
  'Generate a 2-5 word lowercase kebab-case title for this developer chat session. ' +
  'Output ONLY the title, no quotes, no punctuation, no explanation. ' +
  'Example outputs: "fix-login-bug", "refactor-payment-api", "draft-blog-post". ' +
  'User message:';

export class AutoRenameService {
  private readonly notifiedNoProvider = new Set<string>();
  private readonly runningRenames = new Set<SessionId>();

  constructor(private readonly opts: AutoRenameServiceOptions) {}

  async maybeRename(input: RenameInputs): Promise<void> {
    console.log(`[soloe-rename] service: maybeRename entered for ${input.sessionId}`);
    if (this.runningRenames.has(input.sessionId)) {
      console.log(
        `[soloe-rename] service: skip — rename already running for ${input.sessionId}`
      );
      return;
    }
    this.runningRenames.add(input.sessionId);
    try {
      await this.runMaybeRename(input);
    } finally {
      this.runningRenames.delete(input.sessionId);
    }
  }

  private async runMaybeRename(input: RenameInputs): Promise<void> {
    const session = await this.opts.sessionStore.get(input.sessionId);
    if (!session) {
      console.log(`[soloe-rename] service: skip — session not found for ${input.sessionId}`);
      return;
    }
    if (session.autoNamed === false) {
      console.log(
        `[soloe-rename] service: skip — autoNamed=false for ${input.sessionId} (manually renamed)`
      );
      return;
    }
    if (session.launch.type === 'terminal' && !session.currentAgentRuntime) {
      console.log(
        `[soloe-rename] service: skip — terminal launch for ${input.sessionId}`
      );
      return;
    }
    const trimmed = input.firstPrompt.trim();
    if (!trimmed) {
      console.log(`[soloe-rename] service: skip — empty trimmed prompt for ${input.sessionId}`);
      return;
    }

    const settings = await this.opts.settings.get();
    const target = await this.pickProvider(settings);
    if (!target) {
      console.log(
        `[soloe-rename] service: skip — no provider available for ${input.sessionId}`
      );
      this.notifyMissingProvider();
      return;
    }

    console.log(
      `[soloe-rename] service: spawning ${target.provider}/${target.id} for ${input.sessionId} (runMode=${session.runMode}, distro=${session.wslDistro ?? '-'})`
    );
    let raw: string;
    try {
      raw = await this.runOneShot(session, settings.binaries, target, trimmed);
    } catch (err) {
      console.log(
        `[soloe-rename] service: spawn FAILED for ${target.provider} on ${input.sessionId}:`,
        err instanceof Error ? err.message : err
      );
      this.opts.log?.(`auto-rename ${target.provider} failed`, err);
      return;
    }
    console.log(
      `[soloe-rename] service: spawn returned ${raw.length}b for ${input.sessionId}: ${JSON.stringify(raw.slice(0, 200))}`
    );
    const name = sanitizeName(raw);
    if (!name) {
      console.log(
        `[soloe-rename] service: skip — sanitized output was empty for ${input.sessionId}`
      );
      this.opts.log?.('auto-rename produced empty output', { sessionId: session.id });
      return;
    }
    // Re-check the session right before persisting: the agent spawn can take
    // many seconds, during which the user may have manually renamed it (which
    // sets autoNamed=false). Without this guard we'd clobber the manual name.
    const latest = await this.opts.sessionStore.get(session.id);
    if (!latest) {
      console.log(`[soloe-rename] service: skip — session vanished for ${input.sessionId}`);
      return;
    }
    if (latest.autoNamed === false) {
      console.log(
        `[soloe-rename] service: skip — autoNamed=false for ${input.sessionId} (renamed during spawn)`
      );
      return;
    }
    if (name === latest.name) {
      console.log(
        `[soloe-rename] service: skip — proposed name "${name}" matches existing for ${input.sessionId}`
      );
      return;
    }

    try {
      const updated = await this.opts.sessionStore.update(session.id, {
        name,
        autoNamed: true
      });
      console.log(`[soloe-rename] service: renamed ${input.sessionId} to "${name}"`);
      this.opts.onSessionChange?.(updated);
    } catch (err) {
      console.log(
        `[soloe-rename] service: persist failed for ${input.sessionId}:`,
        err instanceof Error ? err.message : err
      );
      this.opts.log?.('auto-rename persist failed', err);
    }
  }

  private async pickProvider(settings: Settings): Promise<ModelSelection | null> {
    const configured = settings.models.textGeneration ?? null;
    const codexAvailable = isBinaryAvailable(settings.binaries, 'codex');
    const claudeAvailable = isBinaryAvailable(settings.binaries, 'claude');
    if (configured && isProviderAvailable(configured.provider, settings.binaries)) {
      return configured;
    }
    if (codexAvailable) return settings.models.textGeneration ?? { provider: 'codex', id: 'gpt-5.4-mini' };
    if (claudeAvailable) return { provider: 'claude', id: 'haiku' };
    return null;
  }

  private notifyMissingProvider(): void {
    const key = 'no-provider';
    if (this.notifiedNoProvider.has(key)) return;
    this.notifiedNoProvider.add(key);
    this.opts.notifier?.toast({
      severity: 'warning',
      message: 'Auto-rename unavailable',
      description:
        'Connect Claude or Codex (Settings → Agent integration) to let Soloe rename sessions from your first prompt.'
    });
  }

  private async runOneShot(
    session: Session,
    binaries: SettingsBinaries,
    target: ModelSelection,
    prompt: string
  ): Promise<string> {
    const truncated = prompt.length > PROMPT_MAX_LENGTH ? prompt.slice(0, PROMPT_MAX_LENGTH) : prompt;
    const fullPrompt = `${NAMING_INSTRUCTION}\n${truncated}`;
    const argv = buildAgentArgv(target, binaries, fullPrompt);
    if (session.runMode === 'wsl') {
      return runWslArgv(session.wslDistro ?? 'Ubuntu', session.cwd, argv, this.opts.spawnImpl);
    }
    return runDirect(argv, this.opts.spawnImpl);
  }
}

function buildAgentArgv(
  target: ModelSelection,
  binaries: SettingsBinaries,
  prompt: string
): { executable: string; args: string[] } {
  if (target.provider === 'codex') {
    const exe = binaries.codex || 'codex';
    // Pin model from settings (cheap default = gpt-5.4-mini) instead of
    // letting codex pick its own — codex's own default may be a frontier
    // model, which is wasteful for naming a session.
    return {
      executable: exe,
      args: ['exec', '--skip-git-repo-check', '--color', 'never', '-m', target.id, prompt]
    };
  }
  const exe = binaries.claude || 'claude';
  return {
    executable: exe,
    args: ['-p', '--model', target.id, '--output-format', 'text', prompt]
  };
}

function isProviderAvailable(provider: ModelProvider, binaries: SettingsBinaries): boolean {
  return isBinaryAvailable(binaries, provider === 'codex' ? 'codex' : 'claude');
}

// We treat a binary as "potentially available" if either the user has set an
// override in Settings, or we have no signal to say otherwise — the actual
// spawn surfaces the truth and is logged on failure. This keeps the picker
// permissive so legitimate setups aren't blocked by a strict pre-check.
function isBinaryAvailable(binaries: SettingsBinaries, key: 'claude' | 'codex'): boolean {
  return Boolean(binaries[key]) || true;
}

async function runDirect(
  argv: { executable: string; args: string[] },
  spawnImpl: typeof spawn = spawn
): Promise<string> {
  return runProcess(argv.executable, argv.args, undefined, spawnImpl);
}

async function runWslArgv(
  distro: string,
  cwd: string,
  argv: { executable: string; args: string[] },
  spawnImpl: typeof spawn = spawn
): Promise<string> {
  const inner = buildWslAgentLine({}, argv.executable, argv.args);
  return runProcess(
    WslCommandBuilder.WSL_EXE,
    ['-d', distro, '--cd', cwd, 'bash', '-lc', inner],
    process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir(),
    spawnImpl
  );
}

function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  spawnImpl: typeof spawn
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`auto-rename timed out after ${RENAME_TIMEOUT_MS}ms`));
    }, RENAME_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) stdout = stdout.slice(0, 64 * 1024);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const message = stderr.trim() || `process exited with code ${code}`;
        reject(new Error(message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function sanitizeName(raw: string): string {
  let value = raw;
  // Drop ANSI escape sequences if the agent prints them.
  // eslint-disable-next-line no-control-regex
  value = value.replace(/\[[0-9;]*[A-Za-z]/g, '');
  value = value.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
  value = value.replace(/^["'`]+|["'`]+$/g, '');
  value = value.replace(/^title[:\s-]+/i, '');
  value = value.replace(/^session[:\s-]+/i, '');
  value = value.replace(/[^A-Za-z0-9 _\-./]/g, '');
  value = value.replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length > NAME_MAX_LENGTH) value = value.slice(0, NAME_MAX_LENGTH).trim();
  return value;
}
