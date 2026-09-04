import type {
  AgentLaunch,
  AgentRuntimeInfo,
  RunMode,
  Session,
  SessionId,
  TerminalLaunch
} from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    return this.wrap(session, inner, ctx);
  }

  buildCodexConfigRead(session: Session, ctx: SessionBuildContext): SpawnSpec {
    const launch = session.launch.type === 'agent' && session.launch.provider === 'codex'
      ? session.launch
      : null;
    const args = [
      ...codexConfigOverrides(launch?.extraArgs),
      'app-server',
      '--listen',
      'stdio://'
    ];
    const inner = buildAgentCommand(
      ctx.binaries?.codex ?? 'codex',
      args,
      {},
      session.runMode
    );
    return this.wrap(session, inner, ctx);
  }

  private wrap(session: Session, inner: InnerCommand, ctx: SessionBuildContext): SpawnSpec {
    if (session.runMode === 'wsl') {
      if (!session.wslDistro) {
        throw new Error('wslDistro is required for WSL sessions');
      }
      return this.wslBuilder.build(inner, {
        distro: session.wslDistro,
        cwd: session.cwd
      });
    }
    if (session.runMode === 'macos' && inner.rawLine) {
      const loginShell = ctx.baseEnv['SHELL']?.trim() || '/bin/zsh';
      return this.nativeBuilder.build({
        executable: loginShell,
        args: ['-lc', inner.rawLine],
        env: {}
      }, {
        cwd: session.cwd,
        baseEnv: ctx.baseEnv
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
        switch (session.launch.provider) {
          case 'claude_code': return this.buildClaude(session, session.launch, ctx);
          case 'codex': return this.buildCodex(session, session.launch, ctx);
          case 'cursor': return this.buildCursor(session, session.launch, ctx);
          case 'opencode': return this.buildOpenCode(session, session.launch, ctx);
          case 'grok_build': return this.buildGrok(session, session.launch, ctx);
          case 'antigravity': return this.buildAntigravity(session, session.launch, ctx);
        }
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

    if (runtime.provider === 'cursor') {
      const threadId = runtime.providerThreadId ?? s.providerThreadId;
      const args = threadId ? ['--resume', threadId] : ['--continue'];
      if (s.launch.type === 'agent' && s.launch.provider === 'cursor') {
        appendAgentLaunchArgs(args, s.launch, 'cursor');
      }
      return buildAgentCommand(
        ctx.binaries?.cursor ?? 'agent',
        args,
        buildSoloeEnv(s.id, s.runMode, 'cursor', ctx),
        s.runMode
      );
    }

    if (runtime.provider === 'opencode') {
      const threadId = runtime.providerThreadId ?? s.providerThreadId;
      const args = threadId ? ['--session', threadId] : ['--continue'];
      if (s.launch.type === 'agent' && s.launch.provider === 'opencode') {
        appendAgentLaunchArgs(args, s.launch, 'opencode');
      }
      return buildAgentCommand(
        ctx.binaries?.opencode ?? 'opencode',
        args,
        buildSoloeEnv(s.id, s.runMode, 'opencode', ctx),
        s.runMode
      );
    }

    if (runtime.provider === 'grok_build') {
      const threadId = runtime.providerThreadId ?? s.providerThreadId;
      const args = threadId ? ['--resume', threadId] : ['--continue'];
      if (s.launch.type === 'agent' && s.launch.provider === 'grok_build') {
        appendAgentLaunchArgs(args, s.launch, 'grok_build');
      }
      return buildAgentCommand(
        ctx.binaries?.grok ?? 'grok',
        args,
        buildSoloeEnv(s.id, s.runMode, 'grok_build', ctx),
        s.runMode
      );
    }

    if (runtime.provider === 'antigravity') {
      const threadId = runtime.providerThreadId ?? s.providerThreadId;
      const args = threadId ? ['--conversation', threadId] : ['--continue'];
      if (s.launch.type === 'agent' && s.launch.provider === 'antigravity') {
        appendAgentLaunchArgs(args, s.launch, 'antigravity');
      }
      return buildAgentCommand(
        ctx.binaries?.antigravity ?? 'agy',
        args,
        buildSoloeEnv(s.id, s.runMode, 'antigravity', ctx),
        s.runMode
      );
    }

    const threadId = runtime.providerThreadId ?? s.providerThreadId;
    const args = threadId
      ? shouldResumeCodexThread(s, threadId, ctx)
        ? ['resume', threadId]
        : []
      : isKnownEmptyCodexSession(s)
        ? []
        : ['resume'];
    appendCodexResumePickerOptions(args);
    appendCodexBridgeOverrides(args, ctx.bridge, s.runMode);
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
      const resolved = this.shellDetector.resolve(launch.shell, s.runMode, ctx.baseEnv);
      const cmdLine = [launch.command, ...(launch.args ?? [])].join(' ');
      return {
        executable: resolved.executable,
        args: [...resolved.args, '-c', cmdLine],
        env: bridgeEnv
      };
    }
    const resolved = this.shellDetector.resolve(launch.shell, s.runMode, ctx.baseEnv);
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
      env: { ...shellLocationEnv(resolved.executable, ctx.baseEnv, s.runMode), ...bridgeEnv }
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
    if (launch.fullscreenTui !== false) env['CLAUDE_CODE_NO_FLICKER'] = '1';
    appendAgentLaunchArgs(args, launch, 'claude_code');
    return buildAgentCommand(ctx.binaries?.claude ?? 'claude', args, env, s.runMode);
  }

  private buildCodex(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const threadId = launch.codexSessionId ?? s.providerThreadId;
        if (threadId && shouldResumeCodexThread(s, threadId, ctx)) {
          args.push('resume', threadId);
        }
        break;
      }
      case 'resume_last':
        args.push('resume');
        appendCodexResumePickerOptions(args);
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
    appendCodexBridgeOverrides(args, ctx.bridge, s.runMode);
    appendCodexTerminalMode(args, launch.extraArgs);
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

  private buildCursor(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const chatId = launch.cursorSessionId ?? s.providerThreadId;
        if (chatId) args.push('--resume', chatId);
        break;
      }
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_id':
        if (!launch.cursorSessionId) {
          throw new Error('cursorSessionId is required for resume_by_id');
        }
        args.push('--resume', launch.cursorSessionId);
        break;
      case 'resume_by_name':
        throw new Error('Cursor does not support resume_by_name');
    }
    appendAgentLaunchArgs(args, launch, 'cursor');
    return buildAgentCommand(
      ctx.binaries?.cursor ?? 'agent',
      args,
      buildSoloeEnv(s.id, s.runMode, 'cursor', ctx),
      s.runMode
    );
  }

  private buildOpenCode(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const sessionId = launch.openCodeSessionId ?? s.providerThreadId;
        if (sessionId) args.push('--session', sessionId);
        break;
      }
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_id':
        if (!launch.openCodeSessionId) {
          throw new Error('openCodeSessionId is required for resume_by_id');
        }
        args.push('--session', launch.openCodeSessionId);
        break;
      case 'resume_by_name':
        throw new Error('OpenCode does not support resume_by_name');
    }
    appendAgentLaunchArgs(args, launch, 'opencode');
    return buildAgentCommand(
      ctx.binaries?.opencode ?? 'opencode',
      args,
      buildSoloeEnv(s.id, s.runMode, 'opencode', ctx),
      s.runMode
    );
  }

  private buildGrok(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const sessionId = launch.grokSessionId ?? s.providerThreadId;
        if (sessionId) args.push('--resume', sessionId);
        break;
      }
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_id':
        if (!launch.grokSessionId) {
          throw new Error('grokSessionId is required for resume_by_id');
        }
        args.push('--resume', launch.grokSessionId);
        break;
      case 'resume_by_name':
        throw new Error('Grok Build does not support resume_by_name');
    }
    appendAgentLaunchArgs(args, launch, 'grok_build');
    return buildAgentCommand(
      ctx.binaries?.grok ?? 'grok',
      args,
      buildSoloeEnv(s.id, s.runMode, 'grok_build', ctx),
      s.runMode
    );
  }

  private buildAntigravity(s: Session, launch: AgentLaunch, ctx: SessionBuildContext): InnerCommand {
    const args: string[] = [];
    switch (launch.resumeMode) {
      case 'new': {
        const conversationId = launch.conversationId ?? s.providerThreadId;
        if (conversationId) args.push('--conversation', conversationId);
        break;
      }
      case 'resume_last':
        args.push('--continue');
        break;
      case 'resume_by_id':
        if (!launch.conversationId) {
          throw new Error('conversationId is required for resume_by_id');
        }
        args.push('--conversation', launch.conversationId);
        break;
      case 'resume_by_name':
        throw new Error('Antigravity does not support resume_by_name');
    }
    appendAgentLaunchArgs(args, launch, 'antigravity');
    return buildAgentCommand(
      ctx.binaries?.antigravity ?? 'agy',
      args,
      buildSoloeEnv(s.id, s.runMode, 'antigravity', ctx),
      s.runMode
    );
  }
}

function appendCodexBridgeOverrides(
  args: string[],
  bridge: SessionBuildContext['bridge'],
  runMode: Session['runMode']
): void {
  if (!bridge) return;
  const url = runMode === 'wsl' ? wslReachableBridgeUrl(bridge.url) : bridge.url;
  args.push(
    '-c',
    'mcp_servers.soloe.enabled=true',
    '-c',
    `mcp_servers.soloe.url=${JSON.stringify(`${url}/mcp`)}`,
    '-c',
    'mcp_servers.soloe.bearer_token_env_var="SOLOE_BRIDGE_TOKEN"'
  );
}

function appendAgentLaunchArgs(
  args: string[],
  launch: AgentLaunch,
  provider: 'claude_code' | 'codex' | 'cursor' | 'opencode' | 'grok_build' | 'antigravity'
): void {
  if (launch.model) {
    if (provider === 'claude_code') args.push('--model', launch.model);
    else if (provider === 'codex') args.push('-m', launch.model);
    else args.push('--model', launch.model);
  }
  if (provider === 'codex' && launch.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${launch.reasoningEffort}`);
  }
  if (provider === 'antigravity' && launch.effort) {
    args.push('--effort', launch.effort);
  }
  if (provider === 'codex') appendCodexTerminalMode(args, launch.extraArgs);
  if (provider === 'cursor' && launch.cursorMode && launch.cursorMode !== 'agent') {
    args.push('--mode', launch.cursorMode);
  }
  appendExtraArgs(args, launch.extraArgs);
}

function appendCodexTerminalMode(args: string[], extraArgs: string[] | undefined): void {
  if (extraArgs?.some((arg) => arg.trim().toLowerCase() === '--no-alt-screen')) return;
  args.push('--no-alt-screen');
}

function appendCodexResumePickerOptions(args: string[]): void {
  if (args.length === 1 && args[0] === 'resume') {
    // Include Codex exec sessions in the picker so Soloe exposes the full
    // conversation history for a worktree, not only interactive TUI runs.
    args.push('--include-non-interactive');
  }
}

export function codexConfigOverrides(extraArgs: string[] | undefined): string[] {
  const source = extraArgs ?? [];
  const result: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const arg = source[index]?.trim() ?? '';
    const normalized = arg.toLowerCase();
    const next = source[index + 1];
    if (
      normalized === '-c'
      || normalized === '--config'
      || normalized === '-p'
      || normalized === '--profile'
      || normalized === '--enable'
      || normalized === '--disable'
    ) {
      if (next !== undefined) {
        result.push(arg, next);
        index += 1;
      }
      continue;
    }
    if (
      normalized.startsWith('--config=')
      || normalized.startsWith('--profile=')
      || normalized.startsWith('--enable=')
      || normalized.startsWith('--disable=')
      || normalized === '--strict-config'
    ) {
      result.push(arg);
      continue;
    }
    if (normalized === '--dangerously-bypass-approvals-and-sandbox') {
      result.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"');
      continue;
    }
    if (normalized === '--ask-for-approval' || normalized === '-a') {
      if (next !== undefined) {
        result.push('-c', `approval_policy=${JSON.stringify(next)}`);
        index += 1;
      }
      continue;
    }
    const approvalValue = optionValue(arg, ['--ask-for-approval', '-a']);
    if (approvalValue !== null) {
      result.push('-c', `approval_policy=${JSON.stringify(approvalValue)}`);
      continue;
    }
    if (normalized === '--sandbox' || normalized === '-s') {
      if (next !== undefined) {
        result.push('-c', `sandbox_mode=${JSON.stringify(next)}`);
        index += 1;
      }
      continue;
    }
    const sandboxValue = optionValue(arg, ['--sandbox', '-s']);
    if (sandboxValue !== null) {
      result.push('-c', `sandbox_mode=${JSON.stringify(sandboxValue)}`);
    }
  }
  return result;
}

function optionValue(arg: string, flags: string[]): string | null {
  const normalized = arg.toLowerCase();
  for (const flag of flags) {
    const prefix = `${flag}=`;
    if (normalized.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function appendExtraArgs(args: string[], extraArgs: string[] | undefined): void {
  if (!extraArgs?.length) return;
  args.push(...extraArgs);
}

function isKnownEmptyClaudeSession(session: Session): boolean {
  return session.hasUserInput === false;
}

function isKnownEmptyCodexSession(session: Session): boolean {
  return session.hasUserInput === false;
}

function shouldResumeCodexThread(
  session: Session,
  threadId: string,
  ctx: SessionBuildContext
): boolean {
  const persistence = codexThreadPersistence(threadId, ctx.baseEnv);
  if (persistence === true) return true;
  if (isKnownEmptyCodexSession(session)) return false;
  if (session.hasUserInput === true) return true;
  return persistence !== false;
}

const CODEX_THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function codexThreadPersistence(
  threadId: string,
  env: Record<string, string | undefined>
): boolean | undefined {
  if (!CODEX_THREAD_UUID.test(threadId)) return undefined;
  const codexHome = env['CODEX_HOME']?.trim()
    || join(env['HOME']?.trim() || env['USERPROFILE']?.trim() || homedir(), '.codex');
  let inspectedDirectory = false;
  let readFailed = false;
  for (const root of [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]) {
    if (!existsSync(root)) continue;
    inspectedDirectory = true;
    const found = directoryContainsThread(root, threadId);
    if (found === true) return true;
    if (found === undefined) readFailed = true;
  }
  return inspectedDirectory && !readFailed ? false : undefined;
}

function directoryContainsThread(root: string, threadId: string): boolean | undefined {
  const pending = [root];
  try {
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          pending.push(join(directory, entry.name));
        } else if (entry.isFile() && entry.name.includes(threadId)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return undefined;
  }
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
  return encodeWslAgentScript(script);
}

export function buildWslAgentProbeLine(executable: string): string {
  const script = executable.includes('/') || executable.includes('\\')
    ? buildPosixCommandLine({}, 'test', ['-x', executable])
    : buildWslAgentPathPrelude(executable);
  return encodeWslAgentScript(script);
}

function encodeWslAgentScript(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `. <(printf %s ${b64} | base64 -d)`;
}

export function buildWslAgentPathPrelude(executable: string): string {
  const exe = posixSingleQuote(executable);
  const notFoundMsg = posixSingleQuote(`${executable}: command not found`);
  return [
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$HOME/.local/share/pnpm:$HOME/.pnpm-global/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$HOME/.asdf/shims:$HOME/.mise/shims:/snap/bin:$PATH"',
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
  provider: 'claude_code' | 'codex' | 'cursor' | 'opencode' | 'grok_build' | 'antigravity' | undefined,
  ctx: SessionBuildContext
): Record<string, string> {
  const inheritedTerm = ctx.baseEnv['TERM']?.trim();
  const env: Record<string, string> = {
    SOLOE_SESSION_ID: sessionId,
    TERM: inheritedTerm && inheritedTerm !== 'dumb' ? inheritedTerm : 'xterm-256color',
    COLORTERM: ctx.baseEnv['COLORTERM']?.trim() || 'truecolor'
  };
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
  baseEnv: Record<string, string | undefined>,
  runMode: RunMode
): Record<string, string> {
  if (runMode === 'macos' && isZsh(executable)) {
    // macOS ships an OSC-7 precmd hook in /etc/zshrc_Apple_Terminal. Selecting
    // that integration makes `cd` observable without touching the user's zsh
    // files or replacing their prompt.
    return { TERM_PROGRAM: 'Apple_Terminal' };
  }
  if (!isBash(executable)) return {};
  const previous = baseEnv['PROMPT_COMMAND'];
  return {
    PROMPT_COMMAND: previous ? `${BASH_LOCATION_PROMPT}; ${previous}` : BASH_LOCATION_PROMPT
  };
}

function isBash(executable: string): boolean {
  return executableName(executable) === 'bash';
}

function isZsh(executable: string): boolean {
  return executableName(executable) === 'zsh';
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
    ...exportLines,
    // Bash themes commonly decide whether to emit colors while .bashrc is
    // sourced. WSL does not inherit Soloe's InnerCommand env, so publish the
    // terminal capabilities before that decision is made.
    'test -r ~/.bashrc && source ~/.bashrc',
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
    '  __soloe_binary="$2"',
    '  shift 2',
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
    '  command "$__soloe_binary" "$@" || __soloe_exit=$?',
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
    'claude() { __soloe_agent_launch claude claude "$@"; }',
    'codex() { __soloe_agent_launch codex codex "$@"; }',
    'agent() { __soloe_agent_launch cursor agent "$@"; }',
    'cursor-agent() { __soloe_agent_launch cursor cursor-agent "$@"; }',
    'opencode() { __soloe_agent_launch opencode opencode "$@"; }',
    'grok() { __soloe_agent_launch grok grok "$@"; }',
    'antigravity() { __soloe_agent_launch antigravity agy "$@"; }',
    'agy() { __soloe_agent_launch antigravity agy "$@"; }'
  ].join('\n');
}
