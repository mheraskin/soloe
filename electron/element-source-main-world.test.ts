/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveSvelteElementInfoInMainWorld } from './element-source-main-world';

describe('main-world Svelte element source resolver', () => {
  it('reads Svelte metadata attached by the inspected page', () => {
    const button = document.createElement('button');
    Object.defineProperty(button, '__svelte_meta', {
      value: {
        loc: {
          file: '/workspace/frontend/dashboard/src/lib/Button.svelte',
          line: 12,
          column: 4
        },
        parent: {
          file: '/workspace/frontend/dashboard/src/routes/+page.svelte',
          line: 30,
          column: 2,
          componentTag: 'Page'
        }
      }
    });
    document.body.appendChild(button);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => button)
    });

    expect(resolveSvelteElementInfoInMainWorld(20, 30)).toEqual({
      ownerDepth: 0,
      info: {
        tagName: 'button',
        componentName: 'Page',
        source: {
          filePath: '/workspace/frontend/dashboard/src/lib/Button.svelte',
          lineNumber: 12,
          columnNumber: 5,
          componentName: 'Page'
        },
        stack: [
          {
            filePath: '/workspace/frontend/dashboard/src/lib/Button.svelte',
            lineNumber: 12,
            columnNumber: 5,
            componentName: 'Page'
          },
          {
            filePath: '/workspace/frontend/dashboard/src/routes/+page.svelte',
            lineNumber: 30,
            columnNumber: 3,
            componentName: 'Page'
          }
        ]
      }
    });
  });

  it('expands package-relative metadata from the inspected Vite app root', () => {
    Reflect.deleteProperty(globalThis, Symbol.for('soloe.element-source.vite-root'));
    const layout = document.createElement('main');
    Object.defineProperty(layout, '__svelte_meta', {
      value: {
        loc: {
          file: 'src/routes/+layout.svelte',
          line: 18,
          column: 2
        }
      }
    });
    document.body.appendChild(layout);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => layout)
    });
    const resourceLookup = vi.fn(() => [{
      name: 'http://ember-oak.localhost:8936/dashboard/@fs/workspace/frontend/dashboard/.svelte-kit/generated/client/app.js'
    }]);
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: resourceLookup
    });

    expect(resolveSvelteElementInfoInMainWorld(20, 30)?.info.source?.filePath)
      .toBe('/workspace/frontend/dashboard/src/routes/+layout.svelte');
    expect(resolveSvelteElementInfoInMainWorld(20, 30)?.info.source?.filePath)
      .toBe('/workspace/frontend/dashboard/src/routes/+layout.svelte');
    expect(resourceLookup).toHaveBeenCalledTimes(1);
  });
});
