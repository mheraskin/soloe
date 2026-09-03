import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("renderer content security policy", () => {
  it("allows only localhost Soloe transports", async () => {
    const html = await readFile(path.join(process.cwd(), "src/index.html"), "utf8");

    expect(html).toContain(
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    );
  });

  it("permits WebAssembly compilation without enabling JavaScript eval", async () => {
    const html = await readFile(path.join(process.cwd(), "src/index.html"), "utf8");

    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(html).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|;)/);
  });

  it("loads interactive artifacts through an isolated frame document", async () => {
    const [html, artifactsPane] = await Promise.all([
      readFile(path.join(process.cwd(), "src/index.html"), "utf8"),
      readFile(
        path.join(process.cwd(), "src/components/rail/RailArtifactsTab.svelte"),
        "utf8",
      ),
    ]);

    expect(html).toContain("frame-src 'self' soloe-artifact:");
    expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(artifactsPane).toContain('sandbox="allow-scripts"');
    expect(artifactsPane).not.toContain("allow-same-origin");
    expect(artifactsPane).toContain("src={frameSource.url}");
    expect(artifactsPane).not.toContain("srcdoc=");
  });
});
