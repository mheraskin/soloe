import { spawn } from 'node:child_process';
import type {
  ModelCatalogEntry
} from '@shared/types/settings.js';
import {
  CLI_DEFAULT_MODEL_CATALOG,
  modelCandidatesForTask
} from '@shared/model-catalog.js';
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
  getModelCatalog?: () => Promise<ModelCatalogEntry[]>;
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
    if (this.runningRenames.has(input.sessionId)) return;
    this.runningRenames.add(input.sessionId);
    try {
      await this.runMaybeRename(input);
    } finally {
      this.runningRenames.delete(input.sessionId);
    }
  }

  private async runMaybeRename(input: RenameInputs): Promise<void> {
    const session = await this.opts.sessionStore.get(input.sessionId);
    if (!session) return;
    if (session.autoNamed === false) return;
    if (session.launch.type === 'terminal' && !session.currentAgentRuntime) return;
    const trimmed = input.firstPrompt.trim();
    if (!trimmed) return;

    const settings = await this.opts.settings.get();
    const catalog = await (this.opts.getModelCatalog?.() ?? Promise.resolve(CLI_DEFAULT_MODEL_CATALOG));
    const candidates = modelCandidatesForTask(settings, catalog, 'textGeneration').candidates;
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
    const name = sanitizeName(raw);
    if (!name) {
      this.opts.log?.('auto-rename produced empty output', { sessionId: session.id });
      return;
    }
    // Re-check the session right before persisting: the agent spawn can take
    // many seconds, during which the user may have manually renamed it (which
    // sets autoNamed=false). Without this guard we'd clobber the manual name.
    const latest = await this.opts.sessionStore.get(session.id);
    if (!latest) return;
    if (latest.autoNamed === false) return;
    if (name === latest.name) return;

    try {
      const updated = await this.opts.sessionStore.update(session.id, {
        name,
        autoNamed: true
      });
      this.opts.onSessionChange?.(updated);
    } catch (err) {
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
