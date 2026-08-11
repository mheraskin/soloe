import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BUDGET_BYTES = 1_750_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = resolve(root, 'out/renderer');
const html = await readFile(resolve(rendererDir, 'index.html'), 'utf8');
const entryMatch = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*><\/script>/u);

if (!entryMatch?.[1]) {
  throw new Error('Could not find the renderer entry script in out/renderer/index.html');
}

const budget = Number(process.env.SOLOE_RENDERER_ENTRY_BUDGET_BYTES ?? DEFAULT_BUDGET_BYTES);
if (!Number.isFinite(budget) || budget <= 0) {
  throw new Error('SOLOE_RENDERER_ENTRY_BUDGET_BYTES must be a positive number');
}

const entryPath = resolve(rendererDir, entryMatch[1].replace(/^\//u, ''));
const { size } = await stat(entryPath);
const sizeKb = (size / 1000).toFixed(2);
const budgetKb = (budget / 1000).toFixed(2);

if (size > budget) {
  throw new Error(
    `Renderer entry is ${sizeKb} kB, exceeding the ${budgetKb} kB startup budget. `
      + 'Check for heavy static imports that belong behind a feature boundary.'
  );
}

console.log(`Renderer entry: ${sizeKb} kB / ${budgetKb} kB budget`);
