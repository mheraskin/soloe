import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// When npm is launched from Windows into WSL it can inherit TEMP/TMP values
// under /mnt/c. Filesystem-heavy tests are dramatically slower there and can
// exceed Vitest's timeout despite passing normally. Keep test scratch data on
// the native Linux filesystem while leaving native Windows/macOS/Linux runs
// untouched.
const testTmpDir =
  process.platform === 'linux' && tmpdir().startsWith('/mnt/') ? '/tmp' : undefined;

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@': resolve(__dirname, 'src'),
      '$lib': resolve(__dirname, 'src/lib')
    }
  },
  test: {
    ...(testTmpDir ? { env: { TMPDIR: testTmpDir } } : {}),
    environment: 'node',
    include: [
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'src/**/*.test.ts',
      'tests/**/*.test.ts'
    ],
    environmentMatchGlobs: [
      ['src/**', 'jsdom']
    ]
  }
});
