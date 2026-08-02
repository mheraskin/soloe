import type { ElementInfo } from 'element-source';

export interface MainWorldElementResolution {
  ownerDepth: number;
  info: ElementInfo;
}

/**
 * Runs through `contextBridge.executeInMainWorld`, so it must remain
 * self-contained: Electron serializes the function without module scope.
 */
export function resolveSvelteElementInfoInMainWorld(
  clientX: number,
  clientY: number
): MainWorldElementResolution | null {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const numberValue = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const viteRootFromUrl = (value: string): string | null => {
    try {
      const pathname = decodeURIComponent(new URL(value, location.href).pathname);
      const fsMarker = pathname.indexOf('/@fs/');
      if (fsMarker < 0) return null;
      let fileSystemPath = pathname.slice(fsMarker + '/@fs'.length);
      if (/^\/[A-Za-z]:\//.test(fileSystemPath)) fileSystemPath = fileSystemPath.slice(1);
      const kitMarker = fileSystemPath.indexOf('/.svelte-kit/');
      return kitMarker > 0 ? fileSystemPath.slice(0, kitMarker) : null;
    } catch {
      return null;
    }
  };
  const viteSourceRoot = (): string | null => {
    const cacheKey = Symbol.for('soloe.element-source.vite-root');
    const cached = Reflect.get(globalThis, cacheKey);
    if (typeof cached === 'string' && cached.length > 0) return cached;
    const remember = (root: string): string => {
      Reflect.set(globalThis, cacheKey, root);
      return root;
    };
    try {
      const resources = performance.getEntriesByType('resource');
      for (const resource of resources) {
        const root = viteRootFromUrl(resource.name);
        if (root) return remember(root);
      }
    } catch {
      // Resource timing can be disabled or cleared by the inspected page.
    }
    for (const script of document.scripts) {
      const content = script.textContent ?? '';
      for (const match of content.matchAll(/["']([^"']*\/@fs\/[^"']*\/\.svelte-kit\/[^"']*)["']/g)) {
        const root = viteRootFromUrl(match[1] ?? '');
        if (root) return remember(root);
      }
    }
    return null;
  };
  let sourceRoot: string | null | undefined;
  const expandSourcePath = (filePath: string): string => {
    if (
      filePath.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(filePath)
      || /^[a-z][a-z\d+.-]*:/i.test(filePath)
    ) return filePath;
    if (sourceRoot === undefined) sourceRoot = viteSourceRoot();
    if (!sourceRoot) return filePath;
    try {
      const rootUrl = /^[A-Za-z]:\//.test(sourceRoot)
        ? `file:///${sourceRoot}/`
        : `file://${sourceRoot}/`;
      let resolved = decodeURIComponent(new URL(filePath.replaceAll('\\', '/'), rootUrl).pathname);
      if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1);
      return resolved;
    } catch {
      return filePath;
    }
  };

  const target = document.elementFromPoint(clientX, clientY);
  if (!target) return null;

  let current: Element | null = target;
  for (let ownerDepth = 0; current && ownerDepth < 6; ownerDepth += 1) {
    const metadata = Reflect.get(current, '__svelte_meta');
    if (isRecord(metadata)) {
      const location = metadata['loc'];
      if (isRecord(location)) {
        const rawFilePath = stringValue(location['file']);
        const lineNumber = numberValue(location['line']);
        const column = numberValue(location['column']);
        if (rawFilePath && lineNumber !== null && column !== null) {
          const filePath = expandSourcePath(rawFilePath);
          const parents: Record<string, unknown>[] = [];
          let parent = metadata['parent'];
          while (isRecord(parent)) {
            parents.push(parent);
            parent = parent['parent'];
          }
          const componentName = parents
            .map((entry) => stringValue(entry['componentTag']))
            .find((entry): entry is string => entry !== null) ?? null;
          const source = {
            filePath,
            lineNumber,
            columnNumber: column + 1,
            componentName
          };
          const stack = [source];
          for (const entry of parents) {
            const rawParentFilePath = stringValue(entry['file']);
            const parentLineNumber = numberValue(entry['line']);
            const parentColumn = numberValue(entry['column']);
            if (!rawParentFilePath || parentLineNumber === null || parentColumn === null) continue;
            stack.push({
              filePath: expandSourcePath(rawParentFilePath),
              lineNumber: parentLineNumber,
              columnNumber: parentColumn + 1,
              componentName: stringValue(entry['componentTag'])
            });
          }
          return {
            ownerDepth,
            info: {
              tagName: target.tagName.toLowerCase(),
              componentName,
              source,
              stack
            }
          };
        }
      }
    }
    current = current.parentElement;
  }
  return null;
}
