export type DiffRpcOp = 'open_for_commits';

export type DiffRpcRequest = {
  requestId: string;
  op: 'open_for_commits';
  args: {
    cwd: string;
    base: string;
    head: string;
    commits: string[];
    includeWorkingTree: boolean;
    focusPath?: string;
  };
};

export type DiffRpcResult =
  | {
      ok: true;
      cwd: string;
      base: string;
      head: string;
      commitCount: number;
    }
  | { ok: false; error: string };

export interface DiffRpcResponse {
  requestId: string;
  result: DiffRpcResult;
}
