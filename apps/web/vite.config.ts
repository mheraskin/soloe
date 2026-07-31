import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const repositoryRoot = resolve(__dirname, "../..");
const webPort = Number(process.env.SOLOE_WEB_PORT ?? "4318");
const backendUrl = process.env.SOLOE_SERVER_URL;

export default defineConfig({
  root: resolve(repositoryRoot, "src"),
  publicDir: resolve(repositoryRoot, "build"),
  plugins: [soloeBrowserHost(), tailwindcss(), svelte()],
  server: {
    host: "127.0.0.1",
    allowedHosts: ["laptoplores.tail1ab873.ts.net"],
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
  const middleware = (): Connect.NextHandleFunction => (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__soloe/ready") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ready: true, backend: backendUrl ?? null }));
      return;
    }

    const token = process.env.SOLOE_SERVER_TOKEN;
    if (!token || !backendUrl) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "browser_host_not_configured",
            message: "The Soloe browser host was not started by the Windows tray",
          },
        }),
      );
      return;
    }
    if (url.pathname === "/" && url.searchParams.get("token") === token) {
      response.writeHead(302, {
        location: "/",
        "set-cookie": `soloe_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!authorized(request.headers.cookie, token)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Open the browser application from the Soloe tray",
          },
        }),
      );
      return;
    }
    next();
  };

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

function authorized(cookieHeader: string | undefined, expected: string): boolean {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === "soloe_token" && decodeURIComponent(value.join("=")) === expected) {
      return true;
    }
  }
  return false;
}
