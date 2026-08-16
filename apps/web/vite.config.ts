import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import {
  addTailscaleWildcardHost,
  createBrowserHostMiddleware,
  resolveBrowserHostAllowedHosts,
} from "./browser-host";

const repositoryRoot = resolve(__dirname, "../..");
const webPort = Number(process.env.SOLOE_WEB_PORT ?? "4318");
const backendUrl = process.env.SOLOE_SERVER_URL;
const allowedHosts = addTailscaleWildcardHost(
  resolveBrowserHostAllowedHosts(process.env.SOLOE_WEB_ALLOWED_HOSTS),
);

export default defineConfig({
  root: resolve(repositoryRoot, "src"),
  publicDir: resolve(repositoryRoot, "build"),
  plugins: [soloeBrowserHost(), tailwindcss(), svelte()],
  server: {
    host: "127.0.0.1",
    allowedHosts,
    port: webPort,
    strictPort: true,
    ...(backendUrl
      ? {
          proxy: {
            "/api": {
              target: backendUrl,
              changeOrigin: false,
              ws: true,
            },
          },
        }
      : {}),
  },
  preview: {
    host: "127.0.0.1",
    allowedHosts,
    port: webPort,
    strictPort: true,
    ...(backendUrl
      ? {
          proxy: {
            "/api": {
              target: backendUrl,
              changeOrigin: false,
              ws: true,
            },
          },
        }
      : {}),
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

function soloeBrowserHost(): Plugin {
  const middleware = () =>
    createBrowserHostMiddleware({
      backendUrl,
      token: process.env.SOLOE_SERVER_TOKEN,
      allowedTailscaleUsers: process.env.SOLOE_TAILSCALE_ALLOWED_USERS,
    });

  return {
    name: "soloe-windows-browser-host",
    configureServer(server) {
      server.middlewares.use(middleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware());
    },
  };
}
