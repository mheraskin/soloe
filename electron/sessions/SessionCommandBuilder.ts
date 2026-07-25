import type {
  AgentLaunch,
  AgentRuntimeInfo,
  Session,
  SessionId,
  TerminalLaunch
} from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { InnerCommand } from '../runtime/InnerCommand.js';
import { NativeCommandBuilder } from '../runtime/WindowsCommandBuilder.js';
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
    private readonly nativeBuilder: NativeCommandBuilder = new NativeCommandBuilder(),
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
    return this.nativeBuilder.build(inner, {
      cwd: session.cwd,
      baseEnv: ctx.baseEnv
    });
  }

  private buildInner(session: Session, ctx: SessionBuildContext): InnerCommand {
    const currentRuntime = session.currentAgentRuntime;
    if (currentRuntime) {
      return this.buildCurrentAgent(session, currentRuntime, ctx);
    }
    switch (session.launch.type) {
      case 'terminal':
        return this.buildStandard(session, session.launch, ctx);
      case 'agent':
        return session.launch.provider === 'claude_code'
          ? this.buildClaude(session, session.launch, ctx)
          : this.buildCodex(session, session.launch, ctx);
    }
  }

  private buildCurrentAgent(
    s: Session,
    runtime: AgentRuntimeInfo,
    ctx: SessionBuildContext
  ): InnerCommand {
    if (runtime.provider === 'claude_code') {
      const threadId = runtime.providerThreadId ?? s.providerThreadId;
      const args = threadId ? ['--resume', threadId] : ['--continue'];
      if (s.launch.type === 'agent' && s.launch.provider === 'claude_code') {
        appendAgentLaunchArgs(args, s.launch, 'claude_code');
      }
      return buildAgentCommand(
        ctx.binaries?.claude ?? 'claude',
        args,
        buildSoloeEnv(s.id, s.runMode, 'claude_code', ctx),
        s.runMode
      );
    }

    const threadId = runtime.providerThreadId ?? s.providerThreadId;
    const args = threadId ? ['resume', threadId] : ['resume'];
    if (s.launch.type === 'agent' && s.launch.provider === 'codex') {
      appendAgentLaunchArgs(args, s.launch, 'codex');
    }
    return buildAgentCommand(
      ctx.binaries?.codex ?? 'codex',
      args,
      buildSoloeEnv(s.id, s.runMode, 'codex', ctx),
      s.runMode
    );
  }

  private buildStandard(s: Session, launch: TerminalLaunch, ctx: SessionBuildContext): InnerCommand {
    const bridgeEnv = buildSoloeEnv(s.id, s.runMode, undefined, ctx);
    if (launch.shell === 'custom') {
      if (!launch.command) throw new Error('Custom shell requires a command');
      return { executable: launch.command, args: launch.args ?? [], env: bridgeEnv };
    }
    if (launch.command) {
      const resolved = this.shellDetector.resolve(launch.shell, s.runMode);
      const cmdLine = [launch.command, ...(launch.args ?? [])].join(' ');
      return {
        executable: resolved.executable,
        args: [...resolved.args, '-c', cmdLine],
        env: bridgeEnv
      };
    }
    const resolved = this.shellDetector.resolve(launch.shell, s.runMode);
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

  private buildClaude(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const sessionId = launch.claudeSessionId ?? s.providerThreadId;
        if (sessionId) {
          args.push(isKnownEmptyClaudeSession(s) ? '--session-id' : '--resume', sessionId);
        }
        break;
      }
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_name':
        if (!launch.claudeSessionName) {
          throw new Error('claudeSessionName is required for resume_by_name');
        }
        args.push('--resume', launch.claudeSessionName);
        break;
      case 'resume_by_id':
        if (!launch.claudeSessionId) {
          throw new Error('claudeSessionId is required for resume_by_id');
        }
        args.push('--resume', launch.claudeSessionId);
        break;
    }
    const env: Record<string, string> = buildSoloeEnv(s.id, s.runMode, 'claude_code', ctx);
    if (launch.fullscreenTui) env['CLAUDE_CODE_NO_FLICKER'] = '1';
    appendAgentLaunchArgs(args, launch, 'claude_code');
    return buildAgentCommand(ctx.binaries?.claude ?? 'claude', args, env, s.runMode);
  }

  private buildCodex(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new':
        if (launch.codexSessionId ?? s.providerThreadId) {
          args.push('resume', launch.codexSessionId ?? s.providerThreadId!);
        }
        break;
      case 'resume_last':
        args.push('resume');
        break;
      case 'resume_by_id':
        if (!launch.codexSessionId) {
          throw new Error('codexSessionId is required for resume_by_id');
        }
        args.push('resume', launch.codexSessionId);
        break;
    }
    if (launch.model) args.push('-m', launch.model);
    if (launch.reasoningEffort) {
      args.push('-c', `model_reasoning_effort=${launch.reasoningEffort}`);
    }
    appendExtraArgs(args, launch.extraArgs);
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

function appendAgentLaunchArgs(
  args: string[],
  launch: AgentLaunch,
  provider: 'claude_code' | 'codex'
): void {
  if (launch.model) {
    if (provider === 'claude_code') args.push('--model', launch.model);
    else args.push('-m', launch.model);
  }
  if (provider === 'codex' && launch.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${launch.reasoningEffort}`);
  }
  appendExtraArgs(args, launch.extraArgs);
}

function appendExtraArgs(args: string[], extraArgs: string[] | undefined): void {
  if (!extraArgs?.length) return;
  args.push(...extraArgs);
}

function isKnownEmptyClaudeSession(session: Session): boolean {
  return session.hasUserInput === false;
}

function buildAgentCommand(
  executable: string,
  args: string[],
  env: Record<string, string>,
  runMode: Session['runMode']
): InnerCommand {
  const inner: InnerCommand = { executable, args, env };
  if (runMode === 'windows') return inner;
  const rawLine = buildWslAgentLine(env, executable, args);
  if (runMode === 'linux') {
    return { executable: 'bash', args: ['-lc', rawLine], env: {} };
  }
  return {
    ...inner,
    rawLine
  };
}

export function buildWslAgentLine(env: Record<string, string>, executable: string, args: string[]): string {
  if (executable.includes('/') || executable.includes('\\')) {
    return buildPosixCommandLine(env, 'exec', [executable, ...args]);
  }
  const script = [
    buildWslAgentPathPrelude(executable),
    buildWslAgentExecLine(env, '"$__soloe_agent_bin"', args)
  ].join('\n');
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `. <(printf %s ${b64} | base64 -d)`;
}

export function buildWslAgentPathPrelude(executable: string): string {
  const exe = posixSingleQuote(executable);
  const notFoundMsg = posixSingleQuote(`${executable}: command not found`);
  return [
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    `__soloe_agent_bin="$(command -v ${exe} 2>/dev/null)"`,
    'case "$__soloe_agent_bin" in',
    '  /mnt/[a-zA-Z]/*) __soloe_agent_bin="" ;;',
    'esac',
    `if [ -z "$__soloe_agent_bin" ] && [ -d "$NVM_DIR/versions/node" ]; then`,
    `  for __soloe_dir in $(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | sort -rV); do`,
    `    if [ -x "$NVM_DIR/versions/node/$__soloe_dir/bin/${executable}" ]; then`,
    `      __soloe_agent_bin="$NVM_DIR/versions/node/$__soloe_dir/bin/${executable}"`,
    `      PATH="$NVM_DIR/versions/node/$__soloe_dir/bin:$PATH"`,
    `      export PATH`,
    `      break`,
    `    fi`,
    `  done`,
    `fi`,
    `if [ -z "$__soloe_agent_bin" ] && [ -s "$NVM_DIR/nvm.sh" ]; then`,
    `  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1`,
    `  __soloe_agent_bin="$(command -v ${exe} 2>/dev/null)"`,
    `  case "$__soloe_agent_bin" in`,
    `    /mnt/[a-zA-Z]/*) __soloe_agent_bin="" ;;`,
    `  esac`,
    `fi`,
    `if [ -z "$__soloe_agent_bin" ]; then`,
    `  printf '%s\\n' ${notFoundMsg} >&2`,
    `  exit 127`,
    `fi`
  ].join('\n');
}

function buildWslAgentExecLine(
  env: Record<string, string>,
  executableExpr: string,
  args: string[]
): string {
  return [
    ...Object.entries(env).map(([key, value]) => `${key}=${posixSingleQuote(value)}`),
    'exec',
    executableExpr,
    ...args.map(posixSingleQuote)
  ].join(' ');
}

function buildSoloeEnv(
  sessionId: SessionId,
  runMode: Session['runMode'],
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
    buildAgentLaunchFunctions(),
    `PROMPT_COMMAND='${escaped}'`,
    'eval "$PROMPT_COMMAND"'
  ];
  const rcContent = rcLines.join('\n');
  const rcB64 = Buffer.from(rcContent, 'utf8').toString('base64');
  return `exec bash --rcfile <(printf %s ${rcB64} | base64 -d) -i`;
}

function buildAgentLaunchFunctions(): string {
  return [
    '__soloe_agent_launch() {',
    '  __soloe_provider="$1"',
    '  shift',
    '  if [ -n "$SOLOE_BRIDGE_URL" ] && [ -n "$SOLOE_BRIDGE_TOKEN" ] && [ -n "$SOLOE_SESSION_ID" ]; then',
    '    __soloe_u="$SOLOE_BRIDGE_URL"',
    '    case "$__soloe_u" in *host.wsl.internal*)',
    '      getent hosts host.wsl.internal >/dev/null 2>&1 || {',
    '        __soloe_h=$(ip route 2>/dev/null | awk \'/^default/ {print $3; exit}\')',
    '        [ -z "$__soloe_h" ] && __soloe_h=$(awk \'/^nameserver/ {print $2; exit}\' /etc/resolv.conf 2>/dev/null)',
    '        [ -n "$__soloe_h" ] && __soloe_u=$(printf \'%s\' "$__soloe_u" | sed "s|host\\.wsl\\.internal|$__soloe_h|")',
    '      }',
    '      ;;',
    '    esac',
    '    __soloe_args_b64=$(printf \'%s\\0\' "$@" | base64 | tr -d \'\\n\')',
    '    printf \'{"hook_event_name":"SessionStart","source":"shell_launch","argv_b64":"%s"}\' "$__soloe_args_b64" | curl -sS --max-time 1 -X POST \\',
    '      -H "Authorization: Bearer $SOLOE_BRIDGE_TOKEN" \\',
    '      -H "X-Soloe-Session-Id: $SOLOE_SESSION_ID" \\',
    '      -H "Content-Type: application/json" \\',
    '      --data-binary @- "$__soloe_u/hook/$__soloe_provider" >/dev/null 2>&1 || true',
    '  fi',
    '  __soloe_exit=0',
    '  command "$__soloe_provider" "$@" || __soloe_exit=$?',
    '  if [ -n "$SOLOE_BRIDGE_URL" ] && [ -n "$SOLOE_BRIDGE_TOKEN" ] && [ -n "$SOLOE_SESSION_ID" ]; then',
    '    __soloe_args_b64=$(printf \'%s\\0\' "$@" | base64 | tr -d \'\\n\')',
    '    printf \'{"hook_event_name":"SessionEnd","source":"shell_launch","argv_b64":"%s","exit_code":%s}\' "$__soloe_args_b64" "$__soloe_exit" | curl -sS --max-time 1 -X POST \\',
    '      -H "Authorization: Bearer $SOLOE_BRIDGE_TOKEN" \\',
    '      -H "X-Soloe-Session-Id: $SOLOE_SESSION_ID" \\',
    '      -H "Content-Type: application/json" \\',
    '      --data-binary @- "$__soloe_u/hook/$__soloe_provider" >/dev/null 2>&1 || true',
    '  fi',
    '  return "$__soloe_exit"',
    '}',
    'claude() { __soloe_agent_launch claude "$@"; }',
    'codex() { __soloe_agent_launch codex "$@"; }'
  ].join('\n');
}
