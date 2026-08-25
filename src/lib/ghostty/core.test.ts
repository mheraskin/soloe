import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("preserves standard, bright, indexed, and truecolor foregrounds", async () => {
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
      core.write(
        "\u001b[36mC\u001b[96mB\u001b[38;5;208mI\u001b[38;2;122;162;247mT\u001b[0mN",
      );
      const [standard, bright, indexed, truecolor, normal] = core.snapshot().rowData[0]!.cells;

      expect(standard?.foreground).not.toEqual(foreground);
      expect(bright?.foreground).not.toEqual(foreground);
      expect(indexed?.foreground).not.toEqual(foreground);
      expect(truecolor?.foreground).toEqual({ r: 122, g: 162, b: 247 });
      expect(normal?.foreground).toEqual(foreground);
    } finally {
      core.dispose();
    }
  });

  it("answers terminal foreground and background color queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const bytes = String(input).includes("write-pty") ? writePtyWasm : ghosttyWasm;
        return new Response(bytes, { status: 200 });
      }),
    );

    let reply = "";
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
      (data) => {
        reply += data;
      },
    );

    try {
      core.write("\u001b]10;?");
      expect(reply).toBe("");
      core.write("\u001b\\\u001b]11;?\u001b\\");
      expect(reply).toBe(
        "\u001b]10;rgb:e6e6/e6e6/e6e6\u001b\\" +
          "\u001b]11;rgb:0f0f/0f0f/1010\u001b\\",
      );

      const beforeReplay = reply;
      core.resetAndWrite("\u001b]10;?\u001b\\\u001b]11;?\u001b\\");
      expect(reply).toBe(beforeReplay);
    } finally {
      core.dispose();
    }
  });

  it("applies an embedder-provided 256-color palette", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const bytes = String(input).includes("write-pty") ? writePtyWasm : ghosttyWasm;
        return new Response(bytes, { status: 200 });
      }),
    );

    const foreground = { r: 230, g: 230, b: 230 };
    const palette = Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 }));
    palette[1] = { r: 247, g: 118, b: 142 };
    palette[208] = { r: 255, g: 135, b: 0 };
    const core = await GhosttyTerminalCore.create(
      20,
      4,
      8,
      16,
      {
        foreground,
        background: { r: 15, g: 15, b: 16 },
        cursor: foreground,
        palette,
      },
      () => undefined,
    );

    try {
      core.write("\u001b[31mR\u001b[38;5;208mI");
      const [red, indexed] = core.snapshot().rowData[0]!.cells;
      expect(red?.foreground).toEqual(palette[1]);
      expect(indexed?.foreground).toEqual(palette[208]);
    } finally {
      core.dispose();
    }
  });
});

describe("GhosttyTerminalCore history replay", () => {
  it("reconstructs output using the dimensions active throughout the original stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const bytes = String(input).includes("write-pty") ? writePtyWasm : ghosttyWasm;
        return new Response(bytes, { status: 200 });
      }),
    );
    const theme = {
      foreground: { r: 230, g: 230, b: 230 },
      background: { r: 15, g: 15, b: 16 },
      cursor: { r: 230, g: 230, b: 230 },
    };
    const output = "ABCDEFGHIJKLMNO\u001b[1BSTATUS";
    const original = await GhosttyTerminalCore.create(10, 4, 8, 16, theme, () => undefined);
    const restored = await GhosttyTerminalCore.create(20, 6, 8, 16, theme, () => undefined);

    try {
      original.write(output);
      original.resize(20, 6, 8, 16);
      restored.resetAndReplay(output, {
        cols: 10,
        rows: 4,
        resizes: [{ offset: output.length, cols: 20, rows: 6 }],
      });
      const text = (core: GhosttyTerminalCore) =>
        core.snapshot().rowData.map((row) => row.text).join("\n");

      expect(text(restored)).toBe(text(original));
    } finally {
      original.dispose();
      restored.dispose();
    }
  });
});

describe("GhosttyTerminalCore keyboard encoding", () => {
  it("keeps shifted printable text consistent across Claude and Codex keyboard modes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const bytes = String(input).includes("write-pty") ? writePtyWasm : ghosttyWasm;
        return new Response(bytes, { status: 200 });
      }),
    );

    const shiftedKey = (code: string, key: string, ctrlKey = false) =>
      ({
        code,
        key,
        shiftKey: true,
        ctrlKey,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        getModifierState: () => false,
      }) as unknown as KeyboardEvent;
    const modes = [
      { name: "legacy", sequence: "" },
      // Captured from Claude Code 2.1.239 in Soloe's Ghostty-backed PTY
      // (which advertises the compatibility TERM=xterm-256color identity).
      { name: "Claude", sequence: "\u001b[>1u\u001b[>4;2m" },
      // Captured from Codex 0.148.0 with Soloe's --no-alt-screen launch flag.
      { name: "Codex", sequence: "\u001b[>4;0m\u001b[>7u" },
    ];

    for (const mode of modes) {
      const core = await GhosttyTerminalCore.create(
        20,
        4,
        8,
        16,
        {
          foreground: { r: 230, g: 230, b: 230 },
          background: { r: 15, g: 15, b: 16 },
          cursor: { r: 230, g: 230, b: 230 },
        },
        () => undefined,
      );

      try {
        if (mode.sequence) core.write(mode.sequence);
        expect(core.encodeKey(shiftedKey("Slash", "?")), mode.name).toBe("?");
        expect(core.encodeKey(shiftedKey("Digit8", "*")), mode.name).toBe("*");
        expect(core.encodeKey(shiftedKey("KeyA", "A")), mode.name).toBe("A");
        if (mode.name === "Claude") {
          expect(core.encodeKey(shiftedKey("Slash", "?", true))).toBe("\u001b[47;6u");
        }
      } finally {
        core.dispose();
      }
    }
  });
});
