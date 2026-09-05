import { describe, expect, it } from 'vitest';
import appSource from '../App.svelte?raw';
import stageSource from './TerminalStage.svelte?raw';
import localStageSource from './TerminalArea.svelte?raw';
import deviceStageSource from './DeviceTerminalStage.svelte?raw';

describe('TerminalStage residency ownership', () => {
  it('owns one global local-and-remote Terminal Presentation budget', () => {
    expect(stageSource.match(/new TerminalResidency\(\)/gu)).toHaveLength(1);
    expect(stageSource).toContain('...liveLocal.map((entry) => entry.key)');
    expect(stageSource).toContain('...liveDevice.map(deviceTerminalPresentationKey)');
    expect(stageSource).toContain('settings.current.terminal.maxResidentPresentations');
    expect(localStageSource).not.toContain('new TerminalResidency');
    expect(deviceStageSource).not.toContain('new DeviceTerminalResidency');
  });

  it('keeps the terminal stage mounted while fullscreen and mobile panes cover it', () => {
    expect(appSource.match(/<TerminalStage/gu)).toHaveLength(2);
    expect(appSource).toContain("class={railFullscreen ? 'hidden' : 'contents'}");
    expect(stageSource).toContain('active={active && !selectedDevice}');
    expect(stageSource).toContain('<DeviceTerminalStage');
  });
});
