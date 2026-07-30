import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const repositoryRoot = resolve(__dirname, "../..");

export default defineConfig({
  root: resolve(repositoryRoot, "src"),
  publicDir: resolve(repositoryRoot, "build"),
  plugins: [tailwindcss(), svelte()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@shared": resolve(repositoryRoot, "shared"),
      "@": resolve(repositoryRoot, "src"),
      $lib: resolve(repositoryRoot, "src/lib"),
    },
  },
  build: {
    outDir: resolve(repositoryRoot, "out/web"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(repositoryRoot, "src/index.html"),
    },
  },
});
