import { describe, expect, it } from 'vitest';
import { WslCommandBuilder } from './WslCommandBuilder.js';

const inner = { executable: 'bash', args: [], env: {} };

describe('WslCommandBuilder — concrete cwd', () => {
  it('emits --cd <cwd> for a regular path', () => {
    const builder = new WslCommandBuilder();
    const spec = builder.build(inner, { distro: 'Ubuntu', cwd: '/home/me/proj' });
    expect(spec.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/proj']);
    expect(spec.args[4]).toBe('bash');
    expect(spec.description).toContain('--cd /home/me/proj');
    expect(spec.description).not.toContain('cd ~ &&');
  });

  it('uses a raw inner shell line when provided', () => {
    const builder = new WslCommandBuilder();
    const spec = builder.build(
      { executable: 'bash', args: [], env: {}, rawLine: 'exec bash --rcfile <(echo ok) -i' },
      { distro: 'Ubuntu', cwd: '/home/me/proj' }
    );
    expect(spec.args[spec.args.length - 1]).toBe('exec bash --rcfile <(echo ok) -i');
  });
});

describe('WslCommandBuilder — ~ home cwd', () => {
  it('drops --cd and prepends `cd ~ && ` to the inner line for ~', () => {
    const builder = new WslCommandBuilder();
    const spec = builder.build(inner, { distro: 'Ubuntu', cwd: '~' });
    expect(spec.args).not.toContain('--cd');
    const innerLine = spec.args[spec.args.length - 1] ?? '';
    expect(innerLine.startsWith('cd ~ && ')).toBe(true);
    expect(spec.description).toContain('cd ~ &&');
    expect(spec.description).not.toContain('--cd ~');
  });

  it('drops --cd and prepends `cd ~/sub && ` for ~/sub', () => {
    const builder = new WslCommandBuilder();
    const spec = builder.build(inner, { distro: 'Ubuntu', cwd: '~/projects/app' });
    expect(spec.args).not.toContain('--cd');
    const innerLine = spec.args[spec.args.length - 1] ?? '';
    expect(innerLine.startsWith('cd ~/projects/app && ')).toBe(true);
  });
});
