import { spawn } from 'node:child_process';
import type {
  ModelSelection,
  Settings
} from '@shared/types/settings.js';
import type { Session, SessionId } from '@shared/types/sessions.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { SettingsStore } from '../settings/SettingsStore.js';
import type { Notifier } from '../notify/Notifier.js';
import { BackgroundAgentExecution } from './BackgroundAgentExecution.js';

export interface AutoRenameServiceOptions {
  sessionStore: SessionStore;
  settings: SettingsStore;
  notifier?: Notifier;
  onSessionChange?: (session: Session) => void;
  log?: (message: string, detail?: unknown) => void;
  // Override binary spawn in tests; production calls runProcess.
  spawnImpl?: typeof spawn;
  execution?: BackgroundAgentExecution;
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

  private readonly execution: BackgroundAgentExecution;

  constructor(private readonly opts: AutoRenameServiceOptions) {
    this.execution = opts.execution ?? new BackgroundAgentExecution({
      ...(opts.spawnImpl ? {
        spawnImpl: opts.spawnImpl,
        // A supplied spawn Adapter is a deterministic test seam; availability
        // is controlled by candidate ordering rather than host PATH.
        isExecutableAvailable: async () => true
      } : {})
    });
  }

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
    const candidates = providerCandidates(settings);
    const truncated = trimmed.length > PROMPT_MAX_LENGTH ? trimmed.slice(0, PROMPT_MAX_LENGTH) : trimmed;
    const result = await this.execution.execute({
      candidates,
      binaries: settings.binaries,
      scope: {
        cwd: session.cwd,
        runMode: session.runMode,
        ...(session.wslDistro ? { wslDistro: session.wslDistro } : {})
      },
      prompt: `${NAMING_INSTRUCTION}\n${truncated}`,
      timeoutMs: RENAME_TIMEOUT_MS,
      priority: 'background',
      maxOutputBytes: 64 * 1024,
      validate: async () => {
        const latest = await this.opts.sessionStore.get(session.id);
        return Boolean(latest && latest.autoNamed !== false);
      }
    });
    if (!result.ok) {
      if (result.reason === 'unavailable') this.notifyMissingProvider();
      if (result.reason !== 'cancelled') {
        this.opts.log?.('auto-rename background agent failed', result.error);
      }
      return;
    }
    const raw = result.text;
    console.log(
      `[soloe-rename] service: ${result.provider.provider}/${result.provider.id} returned ${raw.length}b for ${input.sessionId}: ${JSON.stringify(raw.slice(0, 200))}`
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

}

function providerCandidates(settings: Settings): ModelSelection[] {
  const configured = settings.models.textGeneration ?? null;
  const claudeAllowed = settings.integrations.allowClaudeHeadless === true;
  if (configured) {
    const candidates = configured.provider === 'claude' && !claudeAllowed ? [] : [configured];
    if (configured.provider !== 'codex') {
      candidates.push({ provider: 'codex', id: 'gpt-5.4-mini' });
    } else if (claudeAllowed) {
      candidates.push({ provider: 'claude', id: 'haiku' });
    }
    return candidates;
  }
  const candidates: ModelSelection[] = [];
  if (settings.binaries.codex) candidates.push({ provider: 'codex', id: 'gpt-5.4-mini' });
  if (settings.binaries.claude && claudeAllowed) {
    candidates.push({ provider: 'claude', id: 'haiku' });
  }
  if (candidates.length === 0) {
    candidates.push({ provider: 'codex', id: 'gpt-5.4-mini' });
    if (claudeAllowed) candidates.push({ provider: 'claude', id: 'haiku' });
  }
  return candidates;
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
