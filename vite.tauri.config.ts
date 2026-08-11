import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src',
  plugins: [tailwindcss(), svelte()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@': resolve(__dirname, 'src'),
      $lib: resolve(__dirname, 'src/lib')
    }
  },
  build: {
    outDir: '../out/tauri-renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/tauri.html')
    }
  }
});
