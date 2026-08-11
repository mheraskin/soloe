import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = path.resolve(process.cwd(), 'src');
const RENDERER_ADAPTERS = new Set([
  path.join(RENDERER_ROOT, 'lib', 'ipc.ts'),
  path.join(RENDERER_ROOT, 'lib', 'browser-api.ts')
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.svelte']);

async function rendererSources(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return rendererSources(absolute);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  }));
  return nested.flat();
}

describe('Renderer Backend Interface compatibility', () => {
  it('keeps shell transports behind the renderer backend Adapter', async () => {
    const violations: string[] = [];

    for (const filename of await rendererSources(RENDERER_ROOT)) {
      if (RENDERER_ADAPTERS.has(filename) || filename.endsWith('.test.ts')) continue;
      const source = await fs.readFile(filename, 'utf8');
      if (/\bwindow\s*\.\s*soloe\b/.test(source)) {
        violations.push(`${path.relative(process.cwd(), filename)} accesses window.soloe`);
      }
      if (/\bfrom\s+['"]electron['"]/.test(source)) {
        violations.push(`${path.relative(process.cwd(), filename)} imports Electron`);
      }
    }

    expect(violations).toEqual([]);
  }, 15_000);
});
