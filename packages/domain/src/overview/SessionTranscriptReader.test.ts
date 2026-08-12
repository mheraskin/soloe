import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionTranscriptReader,
  encodeClaudeCwd,
} from "./SessionTranscriptReader.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SessionTranscriptReader authorization", () => {
  it("reads an authorized WSL transcript natively on a WSL backend", async () => {
    const home = await fixtureHome();
    const transcript = await claudeTranscript(home, "/repo", "allowed.jsonl");
    const canonicalTranscript = await realpath(transcript);
    const reader = new SessionTranscriptReader({
      homeDir: home,
      useWslHostBridge: false,
    });

    await expect(
      reader.listScopedSessions(
        [{ transcriptPath: transcript, name: "Allowed" }],
        "/repo",
        { runMode: "wsl", wslDistro: "Ubuntu" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "claude_code",
        sessionId: "allowed",
        displayName: "Allowed",
        sessionFile: canonicalTranscript,
      }),
    ]);
  });

  it("rejects arbitrary paths, symlink escapes, and mismatched worktrees", async () => {
    const home = await fixtureHome();
    const outside = path.join(path.dirname(home), "outside.jsonl");
    await writeFile(outside, record("/repo", "outside"), "utf8");
    const projectDirectory = path.join(
      home,
      ".claude",
      "projects",
      encodeClaudeCwd("/repo"),
    );
    await mkdir(projectDirectory, { recursive: true });
    const linked = path.join(projectDirectory, "linked.jsonl");
    await symlink(outside, linked);
    const wrongWorktree = await claudeTranscript(
      home,
      "/different",
      "wrong.jsonl",
    );
    const reader = new SessionTranscriptReader({
      homeDir: home,
      useWslHostBridge: false,
    });

    await expect(
      reader.listScopedSessions(
        [
          { transcriptPath: outside, name: "Outside" },
          { transcriptPath: linked, name: "Linked" },
          { transcriptPath: wrongWorktree, name: "Wrong" },
        ],
        "/repo",
        { runMode: "linux" },
      ),
    ).resolves.toEqual([]);
  });
});

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "soloe-overview-home-"));
  scratch.push(root);
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
  await mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  return home;
}

async function claudeTranscript(
  home: string,
  cwd: string,
  filename: string,
): Promise<string> {
  const directory = path.join(
    home,
    ".claude",
    "projects",
    encodeClaudeCwd(cwd),
  );
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, filename);
  await writeFile(file, record(cwd, path.basename(filename, ".jsonl")), "utf8");
  return file;
}

function record(cwd: string, sessionId: string): string {
  return `${JSON.stringify({
    type: "user",
    sessionId,
    cwd,
    uuid: `${sessionId}-record`,
    timestamp: "2026-07-31T12:00:00.000Z",
    message: { content: "hello" },
  })}\n`;
}
