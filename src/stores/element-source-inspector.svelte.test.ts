import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementSourceInspector, type InspectorTabContext } from './element-source-inspector.svelte';

const context: InspectorTabContext = {
  tabId: 'tab-1',
  scopeKey: 'scope-1',
  cwd: '/workspace/app',
  runMode: 'linux',
  projectRoot: '/workspace/app',
  pageUrl: 'http://localhost:5173/'
};

afterEach(() => {
  vi.useRealTimers();
  elementSourceInspector.clearAll();
  elementSourceInspector.setActiveScope(null);
});

describe('Element Source Inspector state', () => {
  it('never opens a viewer from hover alone', () => {
    vi.useFakeTimers();
    elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode('scope-1', 'tab-1', true);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'hover',
      tagName: 'BUTTON',
      componentName: 'Button',
      source: {
        filePath: 'src/Button.svelte',
        lineNumber: 42,
        columnNumber: 5,
        componentName: 'Button'
      },
      rect: null
    }, null);

    expect(elementSourceInspector.transient).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(elementSourceInspector.transient).toBeNull();
  });

  it('opens immediately on selection and blocks stale replacement', () => {
    elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode('scope-1', 'tab-1', true);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      tagName: 'A',
      source: {
        filePath: 'src/Link.svelte',
        lineNumber: 8,
        columnNumber: 1,
        componentName: 'Link'
      }
    }, { left: 100, top: 100, width: 40, height: 20 });

    const firstId = elementSourceInspector.transient?.id;
    expect(firstId).toBeTruthy();
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      tagName: 'A',
      source: {
        filePath: 'src/OtherLink.svelte',
        lineNumber: 12,
        columnNumber: 1,
        componentName: 'OtherLink'
      }
    }, null);
    expect(elementSourceInspector.transient?.id).not.toBe(firstId);
    expect(elementSourceInspector.transient?.history[0]?.frame?.filePath).toBe('src/OtherLink.svelte');
  });

  it('keeps pinned viewers while replacing the transient viewer', () => {
    elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode('scope-1', 'tab-1', true);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      source: { filePath: 'src/One.svelte', lineNumber: 1, columnNumber: 1, componentName: 'One' }
    }, null);
    const pinnedId = elementSourceInspector.transient!.id;
    elementSourceInspector.pinViewer(pinnedId);
    expect(elementSourceInspector.pinned).toHaveLength(1);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      source: { filePath: 'src/Two.svelte', lineNumber: 2, columnNumber: 1, componentName: 'Two' }
    }, null);
    expect(elementSourceInspector.pinned[0]?.id).toBe(pinnedId);
    expect(elementSourceInspector.transient?.history[0]?.frame?.filePath).toBe('src/Two.svelte');
  });

  it('opens at the selected component and can move through its source stack', () => {
    elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode('scope-1', 'tab-1', true);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      source: { filePath: 'src/Child.svelte', lineNumber: 14, columnNumber: 1, componentName: 'Child' },
      stack: [
        { filePath: 'src/Child.svelte', lineNumber: 14, columnNumber: 1, componentName: 'Child' },
        { filePath: 'src/Parent.svelte', lineNumber: 28, columnNumber: 3, componentName: 'Parent' },
        { filePath: 'src/routes/+page.svelte', lineNumber: 9, columnNumber: 3, componentName: 'Page' }
      ]
    }, null);
    const id = elementSourceInspector.transient!.id;
    expect(elementSourceInspector.transient?.history[0]?.frame?.filePath).toBe('src/Child.svelte');
    elementSourceInspector.openStackFrame(id, {
      filePath: 'src/Parent.svelte',
      lineNumber: 28,
      columnNumber: 3,
      componentName: 'Parent'
    });
    expect(elementSourceInspector.canGoBack(id)).toBe(true);
    expect(elementSourceInspector.transient?.historyIndex).toBe(1);
    expect(elementSourceInspector.transient?.history[1]?.frame?.filePath).toBe('src/Parent.svelte');
    elementSourceInspector.goBack(id);
    expect(elementSourceInspector.transient?.historyIndex).toBe(0);
    expect(elementSourceInspector.transient?.history[0]?.frame?.filePath).toBe('src/Child.svelte');
  });

  it('cleans viewers and mode state when the project scope changes', () => {
    elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode('scope-1', 'tab-1', true);
    elementSourceInspector.receive('scope-1', 'tab-1', {
      kind: 'select',
      source: { filePath: 'src/Child.svelte', lineNumber: 1, columnNumber: 1, componentName: 'Child' }
    }, null);
    elementSourceInspector.setActiveScope('scope-2');
    expect(elementSourceInspector.transient).toBeNull();
    expect(elementSourceInspector.pinned).toEqual([]);
    expect(elementSourceInspector.isModeActive('scope-1', 'tab-1')).toBe(false);
  });

  it('does not publish reactive updates when panel bounds are unchanged', () => {
    const bounds = { left: 10, top: 20, right: 810, bottom: 620 };
    elementSourceInspector.setPanelBounds(bounds);

    const firstBounds = elementSourceInspector.panelBounds;
    const firstPinned = elementSourceInspector.pinned;

    elementSourceInspector.setPanelBounds({ ...bounds });

    expect(elementSourceInspector.panelBounds).toBe(firstBounds);
    expect(elementSourceInspector.pinned).toBe(firstPinned);
  });
});
