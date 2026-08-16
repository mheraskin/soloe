import type { QuickLaunchPreset } from '@shared/types/settings.js';

export function quickLaunchExtraArgs(preset: QuickLaunchPreset): string[] {
  const args: string[] = [];
  if (preset.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (preset.extraArgs) {
    args.push(...preset.extraArgs.split(/\s+/u).filter(Boolean));
  }
  return args;
}

export function exitedSessionQuickLaunchPresets(
  presets: QuickLaunchPreset[]
): QuickLaunchPreset[] {
  return presets.filter((preset) =>
    preset.id === 'claude-skip-permissions'
    || preset.id === 'codex-yolo'
    || preset.id === 'cursor-force'
  );
}
