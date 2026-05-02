import type {
  ClaudeCodeSession,
  CodexSession,
  Session,
  SessionId,
  StandardTerminalSession
} from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from '../runtime/InnerCommand.js';
import { WindowsCommandBuilder } from '../runtime/WindowsCommandBuilder.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import { buildPosixCommandLine, posixSingleQuote } from '../runtime/posix-quote.js';
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
        return this.buildStandard(session, ctx);
      case 'claude_code':
        return this.buildClaude(session, ctx);
      case 'codex':
        return this.buildCodex(session, ctx);
    }
  }

  private buildStandard(s: StandardTerminalSession, ctx: SessionBuildContext): InnerCommand {
    const bridgeEnv = buildSoloeEnv(s.id, s.runMode, undefined, ctx);
    if (s.shell === 'custom') {
      if (!s.command) throw new Error('Custom shell requires a command');
      return { executable: s.command, args: s.args ?? [], env: bridgeEnv };
    }
    if (s.command) {
      const resolved = this.shellDetector.resolve(s.shell, s.runMode);
      const cmdLine = [s.command, ...(s.args ?? [])].join(' ');
      return {
        executable: resolved.executable,
        args: [...resolved.args, '-c', cmdLine],
        env: bridgeEnv
      };
    }
    const resolved = this.shellDetector.resolve(s.shell, s.runMode);
    if (s.runMode === 'wsl' && isBash(resolved.executable)) {
      return {
        executable: resolved.executable,
        args: [],
        env: {},
        rawLine: buildWslBashLocationLine(bridgeEnv)
      };
    }
    if (isPowerShell(resolved.executable)) {
      return {
        executable: resolved.executable,
        args: [...resolved.args, '-NoExit', '-Command', POWERSHELL_LOCATION_SCRIPT],
        env: bridgeEnv
      };
    }
    return {
      executable: resolved.executable,
      args: resolved.args,
      env: { ...shellLocationEnv(resolved.executable, ctx.baseEnv), ...bridgeEnv }
    };
  }

  private buildClaude(s: ClaudeCodeSession, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (s.resumeMode) {
      case 'new':
        if (s.claudeSessionId ?? s.providerThreadId) {
          args.push('--resume', s.claudeSessionId ?? s.providerThreadId!);
        }
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
    const env: Record<string, string> = buildSoloeEnv(s.id, s.runMode, 'claude_code', ctx);
    if (s.fullscreenTui) env['CLAUDE_CODE_NO_FLICKER'] = '1';
    return buildAgentCommand(ctx.binaries?.claude ?? 'claude', args, env, s.runMode);
  }

  private buildCodex(s: CodexSession, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (s.resumeMode) {
      case 'new':
        if (s.codexSessionId ?? s.providerThreadId) {
          args.push('resume', s.codexSessionId ?? s.providerThreadId!);
        }
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
    return {
      ...buildAgentCommand(
        ctx.binaries?.codex ?? 'codex',
        args,
        buildSoloeEnv(s.id, s.runMode, 'codex', ctx),
        s.runMode
      )
    };
  }
}

function buildAgentCommand(
  executable: string,
  args: string[],
  env: Record<string, string>,
  runMode: 'windows' | 'wsl'
): InnerCommand {
  const inner: InnerCommand = { executable, args, env };
  if (runMode !== 'wsl') return inner;
  return {
    ...inner,
    rawLine: buildWslAgentLine(env, executable, args)
  };
}

function buildWslAgentLine(env: Record<string, string>, executable: string, args: string[]): string {
  return [
    'test -r ~/.bashrc && source ~/.bashrc',
    `exec ${buildPosixCommandLine(env, executable, args)}`
  ].join('; ');
}

function buildSoloeEnv(
  sessionId: SessionId,
  runMode: 'windows' | 'wsl',
  provider: 'claude_code' | 'codex' | undefined,
  ctx: SessionBuildContext
): Record<string, string> {
  const env: Record<string, string> = { SOLOE_SESSION_ID: sessionId };
  if (provider) env['SOLOE_AGENT_PROVIDER'] = provider;
  if (ctx.bridge) {
    env['SOLOE_BRIDGE_URL'] =
      runMode === 'wsl' ? wslReachableBridgeUrl(ctx.bridge.url) : ctx.bridge.url;
    env['SOLOE_BRIDGE_TOKEN'] = ctx.bridge.token;
  }
  return env;
}

export function wslReachableBridgeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '0.0.0.0') {
      u.hostname = 'host.wsl.internal';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

const BASH_LOCATION_PROMPT =
  'printf \'\\033]7;file://%s%s\\007\\033]633;P;Cwd=%s\\007\' ' +
  '"${HOSTNAME:-localhost}" "$PWD" "$PWD"';

const POWERSHELL_LOCATION_SCRIPT =
  '$global:__soloeOriginalPrompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock; ' +
  'function global:prompt { try { $path = (Get-Location).ProviderPath; if ($path) { ' +
  '$uri = [System.Uri]::new($path).AbsoluteUri; [Console]::Write("`e]7;$uri`a") } ' +
  '} catch {} if ($global:__soloeOriginalPrompt) { & $global:__soloeOriginalPrompt } ' +
  'else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " } }';

function shellLocationEnv(
  executable: string,
  baseEnv: Record<string, string | undefined>
): Record<string, string> {
  if (!isBash(executable)) return {};
  const previous = baseEnv['PROMPT_COMMAND'];
  return {
    PROMPT_COMMAND: previous ? `${BASH_LOCATION_PROMPT}; ${previous}` : BASH_LOCATION_PROMPT
  };
}

function isBash(executable: string): boolean {
  return executableName(executable) === 'bash';
}

function isPowerShell(executable: string): boolean {
  const name = executableName(executable);
  return name === 'pwsh' || name === 'pwsh.exe' || name === 'powershell.exe';
}

function executableName(executable: string): string {
  const parts = executable.split(/[\\/]/);
  return (parts[parts.length - 1] ?? executable).toLowerCase();
}

function buildWslBashLocationLine(env: Record<string, string>): string {
  const escaped = BASH_LOCATION_PROMPT.replace(/'/g, "'\\''");
  const exportLines = Object.entries(env).map(
    ([k, v]) => `export ${k}=${posixSingleQuote(v)}`
  );
  const rcLines = [
    'test -r ~/.bashrc && source ~/.bashrc',
    ...exportLines,
    `PROMPT_COMMAND='${escaped}'`,
    'eval "$PROMPT_COMMAND"'
  ];
  const rcContent = rcLines.join('\n');
  const rcB64 = Buffer.from(rcContent, 'utf8').toString('base64');
  return `exec bash --rcfile <(printf %s ${rcB64} | base64 -d) -i`;
}
