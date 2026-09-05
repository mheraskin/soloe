/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  surfaces: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    resetAndReplay: ReturnType<typeof vi.fn>;
    captureViewportIntent: ReturnType<typeof vi.fn>;
    restoreViewportIntent: ReturnType<typeof vi.fn>;
    setPresented: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock('../lib/ghostty/surface', () => ({
  GhosttyTerminalSurface: {
    create: vi.fn(async () => {
      const tracked = {
        dispose: vi.fn(),
        resetAndReplay: vi.fn(),
        captureViewportIntent: vi.fn(() => ({ kind: 'scrollback', rowsFromBottom: 12 })),
        restoreViewportIntent: vi.fn(),
        setPresented: vi.fn()
      };
      mocks.surfaces.push(tracked);
      return {
        ...tracked,
        cols: 80,
        rows: 24,
        write: vi.fn(),
        focus: vi.fn(),
        fit: vi.fn(() => true),
        setTheme: vi.fn(),
        setFont: vi.fn(async () => undefined),
        pasteFromClipboard: vi.fn(async () => undefined)
      };
    })
  }
}));

import GhosttyTerminalHarness from './__fixtures__/GhosttyTerminalHarness.svelte';

describe('GhosttyTerminal surface lifecycle', () => {
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.surfaces = [];
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = '';
  });

  it('keeps the Ghostty surface mounted while presentation is hidden', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(GhosttyTerminalHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaces).toHaveLength(1));
    await vi.waitFor(() => expect(mocks.surfaces[0]?.resetAndReplay).toHaveBeenCalledOnce());

    const harness = component as typeof component & { setVisible(visible: boolean): void };
    flushSync(() => harness.setVisible(false));
    expect(mocks.surfaces).toHaveLength(1);
    expect(mocks.surfaces[0]?.dispose).not.toHaveBeenCalled();
    expect(mocks.surfaces[0]?.setPresented).toHaveBeenLastCalledWith(false);

    flushSync(() => harness.setVisible(true));
    expect(mocks.surfaces).toHaveLength(1);
    expect(mocks.surfaces[0]?.dispose).not.toHaveBeenCalled();
    expect(mocks.surfaces[0]?.setPresented).toHaveBeenLastCalledWith(true);
  });

  it('does not carry scrollback intent across terminal identity changes', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(GhosttyTerminalHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaces[0]?.resetAndReplay).toHaveBeenCalledOnce());

    const harness = component as typeof component & { switchTerminal(): void };
    flushSync(() => harness.switchTerminal());

    await vi.waitFor(() => expect(mocks.surfaces[0]?.resetAndReplay).toHaveBeenCalledTimes(2));
    expect(mocks.surfaces[0]?.restoreViewportIntent).toHaveBeenLastCalledWith({
      kind: 'follow-output'
    });
  });
});
