import { randomUUID } from "node:crypto";
import type {
  CommentsRpcRequest,
  CommentsRpcResponse,
  CommentsRpcResult,
} from "@shared/types/comments-rpc.js";
import type {
  DiffRpcRequest,
  DiffRpcResponse,
  DiffRpcResult,
  OpenForCommitsRequest,
} from "@shared/types/diff-rpc.js";

export interface RendererBridgeServiceOptions {
  publish(event: string, payload: unknown): void;
  commentsTimeoutMs?: number;
  diffTimeoutMs?: number;
}

interface Pending<Result> {
  resolve(result: Result): void;
  timer: NodeJS.Timeout;
  lastError?: Result;
}

export class RendererBridgeService {
  private readonly comments = new Map<string, Pending<CommentsRpcResult>>();
  private readonly diffs = new Map<string, Pending<DiffRpcResult>>();

  constructor(private readonly options: RendererBridgeServiceOptions) {}

  resolveComment(id: string): Promise<CommentsRpcResult> {
    return this.sendComments({
      op: "resolve",
      args: { id: validateCommentId(id) },
    });
  }

  resolveCommentsBatch(ids: string[]): Promise<CommentsRpcResult> {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256) {
      throw new Error("comments batch must contain from 1 to 256 ids");
    }
    return this.sendComments({
      op: "resolve_batch",
      args: { ids: ids.map(validateCommentId) },
    });
  }

  openForCommits(args: OpenForCommitsRequest): Promise<DiffRpcResult> {
    const requestId = randomUUID();
    const request: DiffRpcRequest = {
      requestId,
      op: "open_for_commits",
      args,
    };
    return this.waitFor(
      this.diffs,
      requestId,
      this.options.diffTimeoutMs ?? 8_000,
      { ok: false, error: "client did not respond to diff request" },
      "diff.rpcRequest",
      request,
    );
  }

  handleCommentsResponse(response: CommentsRpcResponse): true {
    this.handleResponse(this.comments, response.requestId, response.result);
    return true;
  }

  handleDiffResponse(response: DiffRpcResponse): true {
    this.handleResponse(this.diffs, response.requestId, response.result);
    return true;
  }

  dispose(): void {
    this.stopPending(this.comments, {
      ok: false,
      error: "comments bridge stopped",
    });
    this.stopPending(this.diffs, {
      ok: false,
      error: "diff bridge stopped",
    });
  }

  private sendComments(
    payload:
      | { op: "resolve"; args: { id: string } }
      | { op: "resolve_batch"; args: { ids: string[] } },
  ): Promise<CommentsRpcResult> {
    const requestId = randomUUID();
    const request = { requestId, ...payload } as CommentsRpcRequest;
    return this.waitFor(
      this.comments,
      requestId,
      this.options.commentsTimeoutMs ?? 5_000,
      { ok: false, error: "client did not respond to comments request" },
      "comments.rpcRequest",
      request,
    );
  }

  private waitFor<Result>(
    pending: Map<string, Pending<Result>>,
    requestId: string,
    timeoutMs: number,
    timeoutResult: Result,
    event: string,
    request: unknown,
  ): Promise<Result> {
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        const call = pending.get(requestId);
        pending.delete(requestId);
        resolve(call?.lastError ?? timeoutResult);
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      this.options.publish(event, request);
    });
  }

  private handleResponse<Result>(
    pending: Map<string, Pending<Result>>,
    requestId: string,
    result: Result,
  ): void {
    const call = pending.get(requestId);
    if (!call) return;
    if (isFailedResult(result)) {
      call.lastError = result;
      return;
    }
    pending.delete(requestId);
    clearTimeout(call.timer);
    call.resolve(result);
  }

  private stopPending<Result>(
    pending: Map<string, Pending<Result>>,
    result: Result,
  ): void {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.resolve(result);
    }
    pending.clear();
  }
}

function isFailedResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false
  );
}

function validateCommentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new Error("comment id must be a non-empty bounded string");
  }
  return value;
}
