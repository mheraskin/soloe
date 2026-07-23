import { describe, expect, it } from 'vitest';
import {
  SessionCommandBuilder,
  type SessionBuildContext,
  wslReachableBridgeUrl
} from './SessionCommandBuilder.js';
import type { Session } from '@shared/types/sessions.js';

const ctx: SessionBuildContext = { baseEnv: {} };
const builder = new SessionCommandBuilder();

const baseFields = (id = 'test') => ({
  id,
  name: id,
  cwd: '/home/me/proj',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: '2026-01-01T00:00:00Z'
});

const innerLine = (args: readonly string[]): string => args[args.length - 1] ?? '';

const decodeAgentScript = (inner: string): string => {
  const m = inner.match(/\. <\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)/);
  if (!m) throw new Error(`expected base64-encoded agent line, got: ${inner}`);
  return Buffer.from(m[1]!, 'base64').toString('utf8');
};

describe('SessionCommandBuilder — wsl wrapping', () => {
  it('wraps a standard bash session in wsl.exe with --cd and -lc', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' }
    };
    const spec = builder.build(s, ctx);
    expect(spec.file).toBe('wsl.exe');
    expect(spec.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/proj', 'bash']);
    expect(spec.args[5]).toBe('-lc');
    const inner = innerLine(spec.args);
    expect(inner).toMatch(/^exec bash --rcfile <\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\) -i$/);
    const m = inner.match(/printf %s ([A-Za-z0-9+/=]+) \| base64/);
    expect(m).not.toBeNull();
    const rc = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(rc).toContain('source ~/.bashrc');
    expect(rc).toContain("PROMPT_COMMAND='printf");
    expect(rc).toContain('633;P;Cwd=%s');
    expect(rc).toContain('"$PWD" "$PWD"');
    expect(rc).toContain('eval "$PROMPT_COMMAND"');
    expect(rc).not.toContain('mkdir');
    expect(rc).not.toContain('.soloe');
    expect(rc).not.toContain('TMPDIR');
    expect(rc).not.toContain('mktemp');
    expect(rc).not.toContain('SOLOE_BASHRC');
    expect(rc).not.toContain('/proc/self/fd/3');
    expect(rc).not.toContain('builtin pwd -P');
    expect(rc).not.toContain('__soloe_cwd');
    expect(rc).not.toContain('__soloe_emit_cwd');
    expect(rc).not.toContain('cd()');
    expect(rc).not.toContain('pushd()');
    expect(rc).not.toContain('popd()');
    expect(spec.description).toContain('-d Ubuntu');
    expect(spec.description).toContain('--cd /home/me/proj');
  });

  it('throws when wsl runMode is set without a wslDistro', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      launch: { type: 'terminal', shell: 'bash' }
    };
    expect(() => builder.build(s, ctx)).toThrow(/wslDistro is required/);
  });

});

describe('SessionCommandBuilder — standard_terminal kind', () => {
  it('runs an inline command via shell -c when command is set', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash', command: 'echo hi' }
    };
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('bash');
    expect(inner).toContain('-c');
    expect(inner).toContain('echo hi');
  });

  it('runs a custom executable directly when shell=custom', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'custom', command: '/usr/bin/htop' }
    };
    expect(innerLine(builder.build(s, ctx).args)).toContain('/usr/bin/htop');
  });

  it('throws when shell=custom is missing a command', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'custom' }
    };
    expect(() => builder.build(s, ctx)).toThrow(/Custom shell requires a command/);
  });

  it('exports SOLOE_SESSION_ID and bridge env into a wsl bash rcfile when ctx.bridge is set', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' }
    };
    const inner = innerLine(
      builder.build(s, {
        ...ctx,
        bridge: { url: 'http://127.0.0.1:1234', token: 'secret' }
      }).args
    );
    const m = inner.match(/printf %s ([A-Za-z0-9+/=]+) \| base64/);
    const rc = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(rc).toContain('export SOLOE_SESSION_ID=test');
    expect(rc).toContain('export SOLOE_BRIDGE_URL=http://host.wsl.internal:1234');
    expect(rc).toContain('export SOLOE_BRIDGE_TOKEN=secret');
    expect(rc).not.toContain('SOLOE_AGENT_PROVIDER');
  });

  it('wraps manual agent launches in WSL bash so terminals promote immediately', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' }
    };
    const inner = innerLine(
      builder.build(s, {
        ...ctx,
        bridge: { url: 'http://127.0.0.1:1234', token: 'secret' }
      }).args
    );
    const m = inner.match(/printf %s ([A-Za-z0-9+/=]+) \| base64/);
    const rc = Buffer.from(m![1]!, 'base64').toString('utf8');
    expect(rc).toContain('claude() { __soloe_agent_launch claude "$@"; }');
    expect(rc).toContain('codex() { __soloe_agent_launch codex "$@"; }');
    expect(rc).toContain('"$__soloe_u/hook/$__soloe_provider"');
    expect(rc).toContain('"hook_event_name":"SessionStart"');
    expect(rc).toContain('"argv_b64":"%s"');
    expect(rc).toContain('"hook_event_name":"SessionEnd"');
    expect(rc).toContain('command "$__soloe_provider" "$@"');
  });

  it('resumes an attached Claude runtime instead of reopening the shell', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' },
      currentAgentRuntime: {
        provider: 'claude_code',
        status: 'active',
        providerThreadId: 'claude-attached-123'
      },
      providerThreadId: 'claude-attached-123'
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('command -v claude');
    expect(script).toContain('--resume claude-attached-123');
  });

  it('preserves attached Claude launch arguments when resuming', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        model: 'sonnet',
        extraArgs: ['--dangerously-skip-permissions']
      },
      currentAgentRuntime: {
        provider: 'claude_code',
        status: 'active',
        providerThreadId: 'claude-attached-123'
      }
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('--resume claude-attached-123 --model sonnet --dangerously-skip-permissions');
  });

  it('resumes an attached Codex runtime instead of reopening the shell', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' },
      currentAgentRuntime: {
        provider: 'codex',
        status: 'active',
        providerThreadId: 'codex-attached-123'
      },
      providerThreadId: 'codex-attached-123'
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('command -v codex');
    expect(script).toContain('resume codex-attached-123');
  });

  it('preserves attached Codex launch arguments when resuming', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: {
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        extraArgs: ['--sandbox', 'danger-full-access']
      },
      currentAgentRuntime: {
        provider: 'codex',
        status: 'active',
        providerThreadId: 'codex-attached-123'
      }
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain(
      'resume codex-attached-123 -m gpt-5.5 -c model_reasoning_effort=high --sandbox danger-full-access'
    );
  });

  it('falls back to provider resume-last commands for attached runtimes without a captured id', () => {
    const claude: Session = {
      ...baseFields('attached-claude'),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' },
      currentAgentRuntime: {
        provider: 'claude_code',
        status: 'active'
      }
    };
    const codex: Session = {
      ...baseFields('attached-codex'),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'terminal', shell: 'bash' },
      currentAgentRuntime: {
        provider: 'codex',
        status: 'active'
      }
    };

    expect(decodeAgentScript(innerLine(builder.build(claude, ctx).args))).toContain('--continue');
    expect(decodeAgentScript(innerLine(builder.build(codex, ctx).args))).toContain(
      'exec "$__soloe_agent_bin" resume'
    );
  });
});

describe('SessionCommandBuilder — claude_code kind', () => {
  const claudeBase = (mode: 'new' | 'resume_last' | 'resume_by_name' | 'resume_by_id'): Session => ({
    ...baseFields(),
    runMode: 'wsl',
    wslDistro: 'Ubuntu',
    launch: { type: 'agent', provider: 'claude_code', resumeMode: mode }
  });

  it('emits plain `claude` for resumeMode=new', () => {
    const script = decodeAgentScript(innerLine(builder.build(claudeBase('new'), ctx).args));
    expect(script).toContain('claude');
    expect(script).not.toContain('--continue');
    expect(script).not.toContain('--resume');
  });

  it('uses captured Claude session id for a persisted new session', () => {
    const s = {
      ...claudeBase('new'),
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new', claudeSessionId: 'claude-123' }
    } as Session;
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('--resume claude-123');
  });

  it('starts a known-empty Claude launch with its assigned session id', () => {
    const assignedSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const s = {
      ...claudeBase('new'),
      launch: {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        claudeSessionId: assignedSessionId
      },
      hasUserInput: false
    } as Session;
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).not.toContain('--resume');
    expect(script).toContain(`--session-id ${assignedSessionId}`);
  });

  it('does not resume the provider global last session for previously used Claude launches without an id', () => {
    const s = {
      ...claudeBase('new'),
      lastUsedAt: '2026-01-01T00:01:00Z'
    } as Session;
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).not.toContain('--continue');
    expect(script).not.toContain('--resume');
  });

  it('emits `claude --continue` for resumeMode=resume_last', () => {
    const script = decodeAgentScript(innerLine(builder.build(claudeBase('resume_last'), ctx).args));
    expect(script).toContain('--continue');
  });

  it('emits `claude --resume <name>` for resume_by_name', () => {
    const s = {
      ...claudeBase('resume_by_name'),
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'resume_by_name', claudeSessionName: 'my-sess' }
    } as Session;
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('--resume');
    expect(script).toContain('my-sess');
  });

  it('throws when resume_by_name has no claudeSessionName', () => {
    expect(() => builder.build(claudeBase('resume_by_name'), ctx)).toThrow(
      /claudeSessionName is required/
    );
  });

  it('throws when resume_by_id has no claudeSessionId', () => {
    expect(() => builder.build(claudeBase('resume_by_id'), ctx)).toThrow(
      /claudeSessionId is required/
    );
  });

  it('exports CLAUDE_CODE_NO_FLICKER=1 when fullscreenTui is enabled', () => {
    const s = {
      ...claudeBase('new'),
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new', fullscreenTui: true }
    } as Session;
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('CLAUDE_CODE_NO_FLICKER=1');
  });

  it('rewrites the bridge host to host.wsl.internal for wsl claude sessions', () => {
    const s = claudeBase('new');
    const script = decodeAgentScript(
      innerLine(
        builder.build(s, {
          ...ctx,
          bridge: { url: 'http://127.0.0.1:1234', token: 'secret' }
        }).args
      )
    );
    expect(script).toContain('command -v claude');
    expect(script).toContain('SOLOE_SESSION_ID=test');
    expect(script).toContain('SOLOE_AGENT_PROVIDER=claude_code');
    expect(script).toContain('SOLOE_BRIDGE_URL=http://host.wsl.internal:1234');
    expect(script).toContain('SOLOE_BRIDGE_TOKEN=secret');
  });
});

describe('SessionCommandBuilder — codex kind', () => {
  it('appends -m and model_reasoning_effort to the codex argv', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: {
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        model: 'gpt-5',
        reasoningEffort: 'high'
      }
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('codex');
    expect(script).toContain('-m gpt-5');
    expect(script).toContain('model_reasoning_effort=high');
  });

  it('emits `codex resume <id>` for resume_by_id', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'resume_by_id', codexSessionId: 'cdx-123' }
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('resume');
    expect(script).toContain('cdx-123');
  });

  it('uses captured Codex session id for a persisted new session', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new', codexSessionId: 'cdx-123' }
    };
    const script = decodeAgentScript(innerLine(builder.build(s, ctx).args));
    expect(script).toContain('resume');
    expect(script).toContain('cdx-123');
  });

  it('rewrites the bridge host to host.wsl.internal for wsl codex sessions', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    };
    const script = decodeAgentScript(
      innerLine(
        builder.build(s, {
          ...ctx,
          bridge: { url: 'http://127.0.0.1:1234', token: 'secret' }
        }).args
      )
    );
    expect(script).toContain('command -v codex');
    expect(script).toContain('SOLOE_SESSION_ID=test');
    expect(script).toContain('SOLOE_AGENT_PROVIDER=codex');
    expect(script).toContain('SOLOE_BRIDGE_URL=http://host.wsl.internal:1234');
    expect(script).toContain('SOLOE_BRIDGE_TOKEN=secret');
  });

  it('bootstraps user bin paths before launching bare codex in wsl sessions', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    };
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toMatch(/^\. <\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)$/);
    const script = decodeAgentScript(inner);
    expect(script).toContain('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"');
    expect(script).toContain('__soloe_agent_bin="$(command -v codex 2>/dev/null)"');
    expect(script).toContain('NVM_DIR');
    expect(script).toContain('SOLOE_SESSION_ID=test SOLOE_AGENT_PROVIDER=codex exec "$__soloe_agent_bin"');
    expect(script).not.toContain('exec SOLOE_SESSION_ID=');
    expect(script).not.toContain('exec codex');
    expect(script).not.toContain('exec bash -ic');
    expect(script).toContain('\n');
    expect(script).not.toContain('done; fi');
  });
});

describe('SessionCommandBuilder — windows runMode', () => {
  it('uses the inner executable directly without wsl wrapping', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'windows',
      launch: { type: 'terminal', shell: 'pwsh' }
    };
    const spec = builder.build(s, ctx);
    expect(spec.file).toBe('pwsh.exe');
    expect(spec.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    expect(spec.args[3]).toContain('function global:prompt');
    expect(spec.cwd).toBe('/home/me/proj');
  });

  it('expands ~ to the user home directory on windows', async () => {
    const os = await import('node:os');
    const s: Session = {
      ...baseFields(),
      runMode: 'windows',
      cwd: '~',
      launch: { type: 'terminal', shell: 'pwsh' }
    };
    const spec = builder.build(s, ctx);
    expect(spec.cwd).toBe(os.homedir());
  });

  it('merges baseEnv with inner env on windows', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'windows',
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new', fullscreenTui: true }
    };
    const spec = builder.build(s, { baseEnv: { PATH: '/usr/bin', HOME: '/h' } });
    expect(spec.env['PATH']).toBe('/usr/bin');
    expect(spec.env['HOME']).toBe('/h');
    expect(spec.env['CLAUDE_CODE_NO_FLICKER']).toBe('1');
  });

  it('does not rewrite bridge host for windows runMode', () => {
    const s: Session = {
      ...baseFields(),
      runMode: 'windows',
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
    };
    const spec = builder.build(s, {
      baseEnv: {},
      bridge: { url: 'http://127.0.0.1:1234', token: 'secret' }
    });
    expect(spec.env['SOLOE_BRIDGE_URL']).toBe('http://127.0.0.1:1234');
  });
});

describe('wslReachableBridgeUrl', () => {
  it('rewrites 127.0.0.1 to host.wsl.internal', () => {
    expect(wslReachableBridgeUrl('http://127.0.0.1:9000')).toBe('http://host.wsl.internal:9000');
  });

  it('rewrites localhost to host.wsl.internal', () => {
    expect(wslReachableBridgeUrl('http://localhost:9000')).toBe('http://host.wsl.internal:9000');
  });

  it('rewrites 0.0.0.0 to host.wsl.internal', () => {
    expect(wslReachableBridgeUrl('http://0.0.0.0:9000')).toBe('http://host.wsl.internal:9000');
  });

  it('preserves non-loopback hosts', () => {
    expect(wslReachableBridgeUrl('http://example.com:9000')).toBe('http://example.com:9000');
  });

  it('returns the original string when not a valid URL', () => {
    expect(wslReachableBridgeUrl('not-a-url')).toBe('not-a-url');
  });
});
