import { describe, expect, it } from 'vitest';
import type { QuickLaunchPreset } from '@shared/types/settings.js';
import {
  exitedSessionQuickLaunchPresets,
  quickLaunchExtraArgs
} from './quick-launch';

const presets: QuickLaunchPreset[] = [
  {
    id: 'claude-skip-permissions',
    label: 'Claude danger',
    provider: 'claude_code',
    dangerouslySkipPermissions: true
  },
  {
    id: 'claude-bypass-permissions',
    label: 'Claude bypass',
    provider: 'claude_code',
    extraArgs: '--permission-mode bypassPermissions'
  },
  {
    id: 'codex-yolo',
    label: 'Codex YOLO',
    provider: 'codex',
    extraArgs: '--dangerously-bypass-approvals-and-sandbox'
  },
  {
    id: 'cursor-force',
    label: 'Cursor force',
    provider: 'cursor',
    extraArgs: '--force --approve-mcps'
  }
];

describe('quick launch helpers', () => {
  it('builds launch arguments from a settings preset', () => {
    expect(quickLaunchExtraArgs(presets[0]!)).toEqual([
      '--dangerously-skip-permissions'
    ]);
    expect(quickLaunchExtraArgs(presets[2]!)).toEqual([
      '--dangerously-bypass-approvals-and-sandbox'
    ]);
    expect(quickLaunchExtraArgs(presets[3]!)).toEqual(['--force', '--approve-mcps']);
  });

  it('selects the exited-session quick options from settings', () => {
    expect(exitedSessionQuickLaunchPresets(presets).map((preset) => preset.label)).toEqual([
      'Claude danger',
      'Codex YOLO',
      'Cursor force'
    ]);
  });
});
