import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error -- this Vitest-only integration test reads vendored WASM from disk.
import { readFileSync } from "node:fs";

import { GhosttyTerminalCore } from "./core";

const ghosttyWasm = new Uint8Array(
  readFileSync(new URL("./vendor/ghostty-vt.wasm", import.meta.url)),
);
const writePtyWasm = new Uint8Array(
  readFileSync(new URL("./vendor/ghostty-write-pty.wasm", import.meta.url)),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GhosttyTerminalCore ANSI colors", () => {
  it("resolves standard and indexed ANSI colors to distinct RGB cells", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const bytes = String(input).includes("write-pty") ? writePtyWasm : ghosttyWasm;
        return new Response(bytes, { status: 200 });
      }),
    );

    const foreground = { r: 230, g: 230, b: 230 };
    const core = await GhosttyTerminalCore.create(
      20,
      4,
      8,
      16,
      {
        foreground,
        background: { r: 15, g: 15, b: 16 },
        cursor: foreground,
      },
      () => undefined,
    );

    try {
      core.write("\u001b[31mR\u001b[38;5;2mG\u001b[0mN");
      const [red, green, normal] = core.snapshot().rowData[0]!.cells;

      expect(red?.text).toBe("R");
      expect(green?.text).toBe("G");
      expect(normal?.text).toBe("N");
      expect(red?.foreground).toEqual({ r: 204, g: 102, b: 102 });
      expect(green?.foreground).toEqual({ r: 181, g: 189, b: 104 });
      expect(normal?.foreground).toEqual(foreground);
    } finally {
      core.dispose();
    }
  });
});
