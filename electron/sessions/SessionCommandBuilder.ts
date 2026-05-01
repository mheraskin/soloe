import type {
  ClaudeCodeSession,
  CodexSession,
  Session,
  StandardTerminalSession
} from '@shared/types/sessions.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from '../runtime/InnerCommand.js';
import { WindowsCommandBuilder } from '../runtime/WindowsCommandBuilder.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import { ShellDetector } from '../terminal/ShellDetector.js';

export interface SessionBuildContext {
  baseEnv: Record<string, string | undefined>;
}

export class SessionCommandBuilder {
  constructor(
    private readonly shellDetector: ShellDetector = new ShellDetector(),
    private readonly windowsBuilder: WindowsCommandBuilder = new WindowsCommandBuilder(),
    private readonly wslBuilder: WslCommandBuilder = new WslCommandBuilder()
  ) {}

  build(session: Session, ctx: SessionBuildContext): SpawnSpec {
    const inner = this.buildInner(session);
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

  private buildInner(session: Session): InnerCommand {
    switch (session.kind) {
      case 'standard_terminal':
        return this.buildStandard(session);
      case 'claude_code':
        return this.buildClaude(session);
      case 'codex':
        return this.buildCodex(session);
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

  private buildClaude(s: ClaudeCodeSession): InnerCommand {
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
    const env: Record<string, string> = {};
    if (s.fullscreenTui) env['CLAUDE_CODE_NO_FLICKER'] = '1';
    return { executable: 'claude', args, env };
  }

  private buildCodex(s: CodexSession): InnerCommand {
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
    return { executable: 'codex', args, env: {} };
  }
}
