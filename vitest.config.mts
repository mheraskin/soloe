import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

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
    environment: 'node',
    include: [
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'src/**/*.test.ts'
    ],
    environmentMatchGlobs: [
      ['src/**', 'jsdom']
    ]
  }
});
