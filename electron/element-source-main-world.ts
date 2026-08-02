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

  const target = document.elementFromPoint(clientX, clientY);
  if (!target) return null;

  let current: Element | null = target;
  for (let ownerDepth = 0; current && ownerDepth < 6; ownerDepth += 1) {
    const metadata = Reflect.get(current, '__svelte_meta');
    if (isRecord(metadata)) {
      const location = metadata['loc'];
      if (isRecord(location)) {
        const filePath = stringValue(location['file']);
        const lineNumber = numberValue(location['line']);
        const column = numberValue(location['column']);
        if (filePath && lineNumber !== null && column !== null) {
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
            const parentFilePath = stringValue(entry['file']);
            const parentLineNumber = numberValue(entry['line']);
            const parentColumn = numberValue(entry['column']);
            if (!parentFilePath || parentLineNumber === null || parentColumn === null) continue;
            stack.push({
              filePath: parentFilePath,
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
