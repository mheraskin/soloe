import type {
  CommentsRpcRequest,
  CommentsRpcResult
} from '@shared/types/comments-rpc.js';
import { diffComments } from '../stores/diff-comments.svelte';
import { backend } from './ipc';

let initialized = false;

export function initCommentsBridge(): void {
  if (initialized) return;
  initialized = true;
  backend.comments.onRpcRequest((req) => {
    void handleRequest(req);
  });
}

async function handleRequest(req: CommentsRpcRequest): Promise<void> {
  let result: CommentsRpcResult;
  try {
    result = await dispatch(req);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  backend.comments.sendRpcResponse({ requestId: req.requestId, result });
}

async function dispatch(req: CommentsRpcRequest): Promise<CommentsRpcResult> {
  switch (req.op) {
    case 'resolve': {
      const existing = diffComments.byId(req.args.id);
      if (!existing) return { ok: false, error: 'comment not found' };
      diffComments.setResolved(req.args.id, true);
      return { ok: true };
    }
    case 'resolve_batch': {
      const known = req.args.ids.filter((id) => diffComments.byId(id));
      if (known.length === 0) return { ok: false, error: 'no comments found' };
      diffComments.setResolvedMany(known, true);
      return { ok: true };
    }
    default: {
      const op: never = req;
      return { ok: false, error: `unknown op: ${String(op)}` };
    }
  }
}
