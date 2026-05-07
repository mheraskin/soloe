export type CommentsRpcOp = 'resolve';

export interface CommentsRpcRequest {
  requestId: string;
  op: CommentsRpcOp;
  args: { id: string };
}

export type CommentsRpcResult =
  | { ok: true }
  | { ok: false; error: string };

export interface CommentsRpcResponse {
  requestId: string;
  result: CommentsRpcResult;
}
