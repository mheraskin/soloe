import type {
  ClaudeCodeSession,
  CodexSession,
  Session,
  StandardTerminalSession
} from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from '../runtime/InnerCommand.js';
import { WindowsCommandBuilder } from '../runtime/WindowsCommandBuilder.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import { ShellDetector } from '../terminal/ShellDetector.js';

export interface SessionBuildContext {
  baseEnv: Record<string, string | undefined>;
  bridge?: {
    url: string;
    token: string;
  };
  binaries?: SettingsBinaries;
}

export class SessionCommandBuilder {
  constructor(
    private readonly shellDetector: ShellDetector = new ShellDetector(),
    private readonly windowsBuilder: WindowsCommandBuilder = new WindowsCommandBuilder(),
    private readonly wslBuilder: WslCommandBuilder = new WslCommandBuilder()
  ) {}

  build(session: Session, ctx: SessionBuildContext): SpawnSpec {
    const inner = this.buildInner(session, ctx);
    if (session.runMode === 'wsl') {
      if (!session.wslDistro) {
        throw new Error('wslDistro is required for WSL sessions');
      }
      return this.wslBuilder.build(inner, {
        distro: session.wslDistro,
        cwd: session.cwd
      });
    }
    return this.windowsBuilder.build(inner, {
      cwd: session.cwd,
      baseEnv: ctx.baseEnv
    });
  }

  private buildInner(session: Session, ctx: SessionBuildContext): InnerCommand {
    switch (session.kind) {
      case 'standard_terminal':
        return this.buildStandard(session);
      case 'claude_code':
        return this.buildClaude(session, ctx);
      case 'codex':
        return this.buildCodex(session, ctx);
    }
  }

  private buildStandard(s: StandardTerminalSession): InnerCommand {
    if (s.shell === 'custom') {
      if (!s.command) throw new Error('Custom shell requires a command');
      return { executable: s.command, args: s.args ?? [], env: {} };
    }
    if (s.command) {
      const resolved = this.shellDetector.resolve(s.shell, s.runMode);
      const cmdLine = [s.command, ...(s.args ?? [])].join(' ');
      return {
        executable: resolved.executable,
        args: [...resolved.args, '-c', cmdLine],
        env: {}
      };
    }
    const resolved = this.shellDetector.resolve(s.shell, s.runMode);
    return { executable: resolved.executable, args: resolved.args, env: {} };
  }

  private buildClaude(s: ClaudeCodeSession, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (s.resumeMode) {
      case 'new':
        break;
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_name':
        if (!s.claudeSessionName) {
          throw new Error('claudeSessionName is required for resume_by_name');
        }
        args.push('--resume', s.claudeSessionName);
        break;
      case 'resume_by_id':
        if (!s.claudeSessionId) {
          throw new Error('claudeSessionId is required for resume_by_id');
        }
        args.push('--resume', s.claudeSessionId);
        break;
    }
    const env: Record<string, string> = this.buildSoloeEnv(s, 'claude_code', ctx);
    if (s.fullscreenTui) env['CLAUDE_CODE_NO_FLICKER'] = '1';
    return { executable: ctx.binaries?.claude ?? 'claude', args, env };
  }

  private buildCodex(s: CodexSession, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (s.resumeMode) {
      case 'new':
        break;
      case 'resume_last':
        args.push('resume');
        break;
      case 'resume_by_id':
        if (!s.codexSessionId) {
          throw new Error('codexSessionId is required for resume_by_id');
        }
        args.push('resume', s.codexSessionId);
        break;
    }
    if (s.model) args.push('-m', s.model);
    if (s.reasoningEffort) {
      args.push('-c', `model_reasoning_effort=${s.reasoningEffort}`);
    }
    return { executable: ctx.binaries?.codex ?? 'codex', args, env: this.buildSoloeEnv(s, 'codex', ctx) };
  }

  private buildSoloeEnv(
    session: ClaudeCodeSession | CodexSession,
    provider: 'claude_code' | 'codex',
    ctx: SessionBuildContext
  ): Record<string, string> {
    const env: Record<string, string> = {
      SOLOE_SESSION_ID: session.id,
      SOLOE_AGENT_PROVIDER: provider
    };
    if (ctx.bridge) {
      env['SOLOE_BRIDGE_URL'] = ctx.bridge.url;
      env['SOLOE_BRIDGE_TOKEN'] = ctx.bridge.token;
    }
    return env;
  }
}
