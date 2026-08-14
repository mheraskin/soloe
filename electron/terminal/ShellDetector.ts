import type { RunMode, ShellKind } from '@shared/types/sessions.js';
import type { InnerCommand } from '../runtime/InnerCommand.js';

export interface ResolvedShell {
  executable: string;
  args: string[];
}

export class ShellDetector {
  resolve(
    shell: ShellKind,
    runMode: RunMode,
    environment: Readonly<Record<string, string | undefined>> = process.env
  ): ResolvedShell {
    if (shell === 'auto') return this.autoFor(runMode, environment);
    if (shell === 'custom') {
      throw new Error('Custom shell must be resolved by SessionCommandBuilder');
    }
    return this.named(shell, runMode);
  }

  autoFor(
    runMode: RunMode,
    environment: Readonly<Record<string, string | undefined>> = process.env
  ): ResolvedShell {
    if (runMode === 'wsl') return { executable: 'bash', args: ['-l'] };
    if (process.platform === 'win32') {
      return { executable: 'pwsh.exe', args: ['-NoLogo'] };
    }
    const userShell = environment['SHELL'];
    if (userShell) return { executable: userShell, args: ['-l'] };
    return { executable: 'bash', args: ['-l'] };
  }

  named(shell: Exclude<ShellKind, 'auto' | 'custom'>, runMode: RunMode): ResolvedShell {
    switch (shell) {
      case 'bash':
        return { executable: 'bash', args: ['-l'] };
      case 'zsh':
        return { executable: 'zsh', args: ['-l'] };
      case 'pwsh':
        return runMode === 'windows'
          ? { executable: 'pwsh.exe', args: ['-NoLogo'] }
          : { executable: 'pwsh', args: ['-NoLogo'] };
      case 'cmd':
        return { executable: 'cmd.exe', args: ['/Q'] };
    }
  }

  toInnerCommand(resolved: ResolvedShell): InnerCommand {
    return { executable: resolved.executable, args: resolved.args, env: {} };
  }
}
