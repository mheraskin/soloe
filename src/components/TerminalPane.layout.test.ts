import { describe, expect, it } from 'vitest';
import source from './TerminalPane.svelte?raw';
import deviceViewerSource from './DeviceTerminalViewer.svelte?raw';
import surfaceSource from './GhosttyTerminal.svelte?raw';
import ghosttySurfaceSource from '../lib/ghostty/surface.ts?raw';

describe('Ghostty terminal presentation', () => {
  it('uses the shared Ghostty surface for local and Device terminals', () => {
    expect(source).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(deviceViewerSource).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(surfaceSource).toContain('GhosttyTerminalSurface.create');
    expect(`${source}\n${deviceViewerSource}\n${surfaceSource}`).not.toContain('@xterm');
  });

  it('renders read-only terminals through the same Ghostty grid', () => {
    expect(source).toContain('interactive={presented && ownsInput}');
    expect(deviceViewerSource).toContain(
      'interactive={active && interactive && acceptsInput && pageVisible}'
    );
    expect(`${source}\n${deviceViewerSource}`).not.toContain('TerminalTranscript');
  });

  it('does not renew or release durable Session Control with pane visibility', () => {
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('terminalControl.release(terminalId)');
    expect(source).not.toContain('connection?.setVisible');
    expect(source).toContain("ipc.terminal.attachSession(");
    expect(source).toMatch(/ipc\.terminal\.attachSession\([\s\S]*?true\s*\)/);
  });

  it('keeps resident Ghostty state while pausing hidden canvas paint', () => {
    expect(surfaceSource).toContain('surface?.setPresented(presented)');
    expect(ghosttySurfaceSource).toContain('setPresented(presented: boolean)');
    expect(source).toContain('interactive={presented && ownsInput}');
  });

  it('applies bounded reset and append operations without copying full history', () => {
    expect(surfaceSource).toContain('terminalPresentationUpdates');
    expect(surfaceSource).toContain('current.resetAndReplay(update.reset.data, update.reset.replay)');
    expect(surfaceSource).toContain('current.write(update.event.data)');
    expect(surfaceSource).not.toContain('startsWith(appliedBuffer)');
  });

  it('preserves follow or scrollback intent when a Ghostty surface is recreated', () => {
    expect(surfaceSource).toContain('current.captureViewportIntent()');
    expect(surfaceSource).toContain('current.restoreViewportIntent(viewportIntent)');
  });

  it('requests a real PTY resize cycle after restoring a truncated replay tail', () => {
    expect(source).toContain("terminalState.status.kind === 'ready'");
    expect(source).toContain('terminalState.status.truncated');
    expect(deviceViewerSource).toContain(
      "terminalState?.status.kind === 'ready'"
    );
    expect(deviceViewerSource).toContain('terminalState.status.truncated');
    expect(source).toContain('terminalPresentationRedrawSizes(dimensions)');
    expect(deviceViewerSource).toContain('terminalPresentationRedrawSizes(dimensions)');
  });

  it('refits Ghostty after the mobile keyboard changes the visible viewport', () => {
    expect(ghosttySurfaceSource).toContain('window.addEventListener("soloe:rail-layout"');
    expect(ghosttySurfaceSource).toMatch(
      /onLayoutChange[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*this\.fit\(\)/
    );
  });

  it('enables momentum swipe scrolling in the shared local and remote Ghostty surface', () => {
    expect(ghosttySurfaceSource).toContain('private startTouchMomentum(');
    expect(ghosttySurfaceSource).toContain('terminalTouchMomentumStep(');
    expect(surfaceSource).toContain('GhosttyTerminalSurface.create');
  });
});
