import { runModeLabel } from '@shared/platform.js';
import type { RunMode, ShellKind } from '@shared/types/sessions.js';
import type { HostPlatform, HostPlatformInfo } from '@shared/types/system.js';
import type {
  AgentIntegrationHost,
  AgentIntegrationHostKey
} from '@shared/types/ipc.js';
import type { BackendPlacement } from '@shared/types/settings.js';

export interface RunModeOption {
  value: RunMode;
  label: string;
}

export function usesMacosNativeWindowControls(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  navigatorPlatform: string = typeof navigator === 'undefined' ? '' : navigator.platform
): boolean {
  return /\bElectron\//u.test(userAgent) && navigatorPlatform.startsWith('Mac');
}

export function usesMacosOverlayScrollbars(
  navigatorPlatform: string = typeof navigator === 'undefined' ? '' : navigator.platform
): boolean {
  return navigatorPlatform.startsWith('Mac');
}

export function platformRunModeOptions(info: HostPlatformInfo): RunModeOption[] {
  return info.availableRunModes.map((value) => ({ value, label: runModeLabel(value) }));
}

export function platformShellOptions(platform: HostPlatform): ShellKind[] {
  const posix: ShellKind[] = ['auto', 'bash', 'zsh', 'pwsh', 'custom'];
  return platform === 'windows'
    ? ['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom']
    : posix;
}

export function agentIntegrationHostKey(
  host: AgentIntegrationHost
): AgentIntegrationHostKey {
  if (host.kind === 'wsl') {
    if (!host.distro) throw new Error('WSL integration host requires a distribution');
    return { kind: 'wsl', distro: host.distro };
  }
  return { kind: host.kind };
}

export function runModePathPlaceholder(runMode: RunMode): string {
  if (runMode === 'windows') return 'C:\\Users\\you\\project';
  if (runMode === 'macos') return '/Users/you/project';
  return '/home/you/project';
}

export function platformBackendOptions(
  platform: HostPlatform
): Array<{ value: BackendPlacement; label: string }> {
  if (platform === 'macos') return [{ value: 'macos', label: 'macOS' }];
  if (platform === 'linux') return [{ value: 'linux', label: 'Linux' }];
  return [
    { value: 'windows', label: 'Windows' },
    { value: 'wsl', label: 'WSL (Linux)' }
  ];
}
