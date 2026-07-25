import type { RunMode } from './types/sessions.js';
import type { HostPlatformInfo } from './types/system.js';

export type SupportedHostPlatform = 'windows' | 'linux';

export function hostPlatform(nodePlatform: string = currentNodePlatform()): SupportedHostPlatform {
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'linux') return 'linux';
  throw new Error(`Soloe does not support ${nodePlatform}. Use a Windows or Linux build.`);
}

export function nativeRunMode(nodePlatform: string = currentNodePlatform()): Exclude<RunMode, 'wsl'> {
  return hostPlatform(nodePlatform);
}

export function supportedRunModes(platform: SupportedHostPlatform): RunMode[] {
  return platform === 'windows' ? ['windows', 'wsl'] : ['linux'];
}

export function platformInfo(
  nodePlatform: string = currentNodePlatform()
): HostPlatformInfo {
  const platform = hostPlatform(nodePlatform);
  return {
    platform,
    defaultRunMode: platform,
    availableRunModes: supportedRunModes(platform),
    supportsWsl: platform === 'windows'
  };
}

function currentNodePlatform(): string {
  const value = (globalThis as { process?: { platform?: string } }).process?.platform;
  if (!value) throw new Error('Host platform is only available in the main process');
  return value;
}

export function runModeLabel(runMode: RunMode): string {
  switch (runMode) {
    case 'windows': return 'Windows';
    case 'linux': return 'Linux';
    case 'wsl': return 'WSL';
  }
}
