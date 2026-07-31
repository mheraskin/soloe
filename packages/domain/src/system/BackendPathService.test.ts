import { describe, expect, it, vi } from "vitest";
import type { Session } from "@shared/types/sessions.js";
import {
  BackendPathService,
  detectPathPlacement,
} from "./BackendPathService.js";

const session: Session = {
  id: "session-1",
  name: "Backend session",
  cwd: "/work/repository",
  runMode: "linux",
  launch: { type: "terminal", shell: "auto" },
  createdAt: "2026-07-31T00:00:00.000Z",
  lastUsedAt: "2026-07-31T00:00:00.000Z",
};

describe("BackendPathService", () => {
  it("opens only a directory resolved from an existing session", async () => {
    const launch = vi.fn(async () => {});
    const service = new BackendPathService({
      getSession: vi.fn(async (sessionId) =>
        sessionId === session.id ? session : null,
      ),
      placement: "linux",
      launch,
    });

    await expect(service.openSessionPath(session.id)).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith("linux", session.cwd);
    await expect(service.openSessionPath("missing")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("rejects malformed session identifiers before store access", async () => {
    const getSession = vi.fn(async () => session);
    const service = new BackendPathService({
      getSession,
      placement: "linux",
      launch: vi.fn(),
    });

    for (const sessionId of ["", "x".repeat(257), "bad\0id", "/work/repository"]) {
      await expect(service.openSessionPath(sessionId)).rejects.toMatchObject({
        code: "invalid_session_id",
      });
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("detects the selected backend placement", () => {
    expect(detectPathPlacement("win32", {})).toBe("windows");
    expect(detectPathPlacement("darwin", {})).toBe("macos");
    expect(detectPathPlacement("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl");
    expect(detectPathPlacement("linux", {})).toBe("linux");
  });
});
