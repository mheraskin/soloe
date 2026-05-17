export type CommentsRpcOp = 'resolve' | 'resolve_batch';

export type CommentsRpcRequest =
  | { requestId: string; op: 'resolve'; args: { id: string } }
  | { requestId: string; op: 'resolve_batch'; args: { ids: string[] } };

export type CommentsRpcResult =
  | { ok: true }
  | { ok: false; error: string };

export interface CommentsRpcResponse {
  requestId: string;
  result: CommentsRpcResult;
}
