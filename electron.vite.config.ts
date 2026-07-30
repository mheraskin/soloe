import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      outDir: resolve(__dirname, 'out/main'),
      lib: {
        entry: resolve(__dirname, 'electron/main.ts'),
        formats: ['cjs']
      },
      rollupOptions: {
        external: ['electron', 'node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      rollupOptions: {
        // The browser pane preload runs inside the <webview> guest process
        // and forwards Soloe shortcuts back to the host renderer; it must
        // build as a separate CJS file so Electron's session preload API
        // can load it from disk.
        input: {
          preload: resolve(__dirname, 'electron/preload.ts'),
          'preload-remote': resolve(__dirname, 'electron/preload-remote.ts'),
          'preload-webview': resolve(__dirname, 'electron/preload-webview.ts')
        },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    publicDir: resolve(__dirname, 'build'),
    plugins: [tailwindcss(), svelte()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@': resolve(__dirname, 'src'),
        $lib: resolve(__dirname, 'src/lib')
      }
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html')
      }
    }
  }
});
