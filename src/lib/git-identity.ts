export interface GitIdentityPart {
  kind: 'branch' | 'worktree';
  icon: 'branch' | 'commit' | 'worktree';
  label: string;
}

export function gitIdentityParts(
  branch: string,
  worktree: string,
  detached = false
): readonly [GitIdentityPart, GitIdentityPart] {
  return [
    { kind: 'branch', icon: detached ? 'commit' : 'branch', label: branch },
    { kind: 'worktree', icon: 'worktree', label: worktree }
  ];
}
