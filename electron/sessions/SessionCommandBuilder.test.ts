import { describe, expect, it } from 'vitest';
import { SessionCommandBuilder, type SessionBuildContext } from './SessionCommandBuilder.js';
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

describe('SessionCommandBuilder — wsl wrapping', () => {
  it('wraps a standard bash session in wsl.exe with --cd and -lc', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'standard_terminal',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'bash'
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
      kind: 'standard_terminal',
      runMode: 'wsl',
      shell: 'bash'
    };
    expect(() => builder.build(s, ctx)).toThrow(/wslDistro is required/);
  });
});

describe('SessionCommandBuilder — standard_terminal kind', () => {
  it('runs an inline command via shell -c when command is set', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'standard_terminal',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'bash',
      command: 'echo hi'
    };
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('bash');
    expect(inner).toContain('-c');
    expect(inner).toContain('echo hi');
  });

  it('runs a custom executable directly when shell=custom', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'standard_terminal',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'custom',
      command: '/usr/bin/htop'
    };
    expect(innerLine(builder.build(s, ctx).args)).toContain('/usr/bin/htop');
  });

  it('throws when shell=custom is missing a command', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'standard_terminal',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'custom'
    };
    expect(() => builder.build(s, ctx)).toThrow(/Custom shell requires a command/);
  });
});

describe('SessionCommandBuilder — claude_code kind', () => {
  const claudeBase = (mode: 'new' | 'resume_last' | 'resume_by_name' | 'resume_by_id'): Session => ({
    ...baseFields(),
    kind: 'claude_code',
    runMode: 'wsl',
    wslDistro: 'Ubuntu',
    resumeMode: mode
  });

  it('emits plain `claude` for resumeMode=new', () => {
    const inner = innerLine(builder.build(claudeBase('new'), ctx).args);
    expect(inner).toContain('claude');
    expect(inner).not.toContain('--continue');
    expect(inner).not.toContain('--resume');
  });

  it('uses captured Claude session id for a persisted new session', () => {
    const s = { ...claudeBase('new'), claudeSessionId: 'claude-123' } as Session;
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('--resume claude-123');
  });

  it('falls back to `claude --continue` for previously used sessions without an id', () => {
    const s = {
      ...claudeBase('new'),
      lastUsedAt: '2026-01-01T00:01:00Z'
    } as Session;
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('--continue');
  });

  it('emits `claude --continue` for resumeMode=resume_last', () => {
    expect(innerLine(builder.build(claudeBase('resume_last'), ctx).args)).toContain('--continue');
  });

  it('emits `claude --resume <name>` for resume_by_name', () => {
    const s = { ...claudeBase('resume_by_name'), claudeSessionName: 'my-sess' } as Session;
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('--resume');
    expect(inner).toContain('my-sess');
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
    const s = { ...claudeBase('new'), fullscreenTui: true } as Session;
    expect(innerLine(builder.build(s, ctx).args)).toContain('CLAUDE_CODE_NO_FLICKER=1');
  });

  it('injects Soloe bridge environment for Claude TUI sessions', () => {
    const s = claudeBase('new');
    const inner = innerLine(builder.build(s, {
      ...ctx,
      bridge: { url: 'http://127.0.0.1:1234/mcp', token: 'secret' }
    }).args);
    expect(inner).toContain('SOLOE_SESSION_ID=test');
    expect(inner).toContain('SOLOE_AGENT_PROVIDER=claude_code');
    expect(inner).toContain('SOLOE_BRIDGE_URL=http://127.0.0.1:1234/mcp');
    expect(inner).toContain('SOLOE_BRIDGE_TOKEN=secret');
  });
});

describe('SessionCommandBuilder — codex kind', () => {
  it('appends -m and model_reasoning_effort to the codex argv', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'codex',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'new',
      model: 'gpt-5',
      reasoningEffort: 'high'
    };
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('codex');
    expect(inner).toContain('-m gpt-5');
    expect(inner).toContain('model_reasoning_effort=high');
  });

  it('emits `codex resume <id>` for resume_by_id', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'codex',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'resume_by_id',
      codexSessionId: 'cdx-123'
    };
    const inner = innerLine(builder.build(s, ctx).args);
    expect(inner).toContain('resume');
    expect(inner).toContain('cdx-123');
  });

  it('injects Soloe bridge environment for Codex TUI sessions', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'codex',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'new'
    };
    const inner = innerLine(builder.build(s, {
      ...ctx,
      bridge: { url: 'http://127.0.0.1:1234/mcp', token: 'secret' }
    }).args);
    expect(inner).toContain('SOLOE_SESSION_ID=test');
    expect(inner).toContain('SOLOE_AGENT_PROVIDER=codex');
    expect(inner).toContain('SOLOE_BRIDGE_URL=http://127.0.0.1:1234/mcp');
    expect(inner).toContain('SOLOE_BRIDGE_TOKEN=secret');
  });
});

describe('SessionCommandBuilder — windows runMode', () => {
  it('uses the inner executable directly without wsl wrapping', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'standard_terminal',
      runMode: 'windows',
      shell: 'pwsh'
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
      kind: 'standard_terminal',
      runMode: 'windows',
      shell: 'pwsh',
      cwd: '~'
    };
    const spec = builder.build(s, ctx);
    expect(spec.cwd).toBe(os.homedir());
  });

  it('merges baseEnv with inner env on windows', () => {
    const s: Session = {
      ...baseFields(),
      kind: 'claude_code',
      runMode: 'windows',
      resumeMode: 'new',
      fullscreenTui: true
    };
    const spec = builder.build(s, { baseEnv: { PATH: '/usr/bin', HOME: '/h' } });
    expect(spec.env['PATH']).toBe('/usr/bin');
    expect(spec.env['HOME']).toBe('/h');
    expect(spec.env['CLAUDE_CODE_NO_FLICKER']).toBe('1');
  });
});
