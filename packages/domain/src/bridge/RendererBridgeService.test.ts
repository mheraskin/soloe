import { describe, expect, it, vi } from "vitest";
import { RendererBridgeService } from "./RendererBridgeService.js";

describe("RendererBridgeService", () => {
  it("publishes requests and resolves the first successful client response", async () => {
    const publish = vi.fn();
    const service = new RendererBridgeService({
      publish,
      commentsTimeoutMs: 50,
    });
    const result = service.resolveComment("comment-1");
    const request = publish.mock.calls[0]?.[1] as { requestId: string };

    service.handleCommentsResponse({
      requestId: request.requestId,
      result: { ok: false, error: "not present in this client" },
    });
    service.handleCommentsResponse({
      requestId: request.requestId,
      result: { ok: true },
    });

    await expect(result).resolves.toEqual({ ok: true });
    expect(publish).toHaveBeenCalledWith(
      "comments.rpcRequest",
      expect.objectContaining({
        requestId: request.requestId,
        op: "resolve",
        args: { id: "comment-1" },
      }),
    );
    service.dispose();
  });

  it("returns the last client error on timeout and settles pending work on dispose", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const service = new RendererBridgeService({
        publish,
        commentsTimeoutMs: 25,
        diffTimeoutMs: 25,
      });
      const commentResult = service.resolveCommentsBatch(["one", "two"]);
      const request = publish.mock.calls[0]?.[1] as { requestId: string };
      service.handleCommentsResponse({
        requestId: request.requestId,
        result: { ok: false, error: "comments unavailable" },
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(commentResult).resolves.toEqual({
        ok: false,
        error: "comments unavailable",
      });

      const diffResult = service.openForCommits({
        target: {
          sessionId: "session-1",
          scope: { cwd: "/repo", runMode: "linux" },
        },
        base: "base",
        head: "head",
        commits: [],
        includeWorkingTree: false,
      });
      const diffRequest = publish.mock.calls[1]?.[1] as { requestId: string };
      service.handleDiffResponse({
        requestId: diffRequest.requestId,
        result: {
          ok: true,
          sessionId: "session-1",
          cwd: "/repo",
          base: "base",
          head: "head",
          commitCount: 1,
        },
      });
      await expect(diffResult).resolves.toEqual({
        ok: true,
        sessionId: "session-1",
        cwd: "/repo",
        base: "base",
        head: "head",
        commitCount: 1,
      });
      expect(publish).toHaveBeenLastCalledWith(
        "diff.rpcRequest",
        expect.objectContaining({
          requestId: diffRequest.requestId,
          op: "open_for_commits",
        }),
      );

      const pendingDiff = service.openForCommits({
        target: {
          sessionId: "session-1",
          scope: { cwd: "/repo", runMode: "linux" },
        },
        base: "base",
        head: "head",
        commits: [],
        includeWorkingTree: false,
      });
      service.dispose();
      await expect(pendingDiff).resolves.toEqual({
        ok: false,
        error: "diff bridge stopped",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized and empty comment requests before publication", () => {
    const publish = vi.fn();
    const service = new RendererBridgeService({ publish });

    expect(() => service.resolveComment("")).toThrow(
      "comment id must be a non-empty bounded string",
    );
    expect(() => service.resolveComment("x".repeat(513))).toThrow(
      "comment id must be a non-empty bounded string",
    );
    expect(() => service.resolveCommentsBatch([])).toThrow(
      "comments batch must contain from 1 to 256 ids",
    );
    expect(publish).not.toHaveBeenCalled();
    service.dispose();
  });
});
