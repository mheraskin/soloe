import type { GitCheckoutLossEvidence } from '@shared/types/git.js';
import type { Session } from '@shared/types/sessions.js';
import type {
  CheckoutLossBlocker,
  CheckoutLossReport,
  DeviceWorkspaceSnapshot
} from '@shared/types/workspaces.js';

export interface CheckoutLossScannerOptions {
  workspace: { snapshot(): DeviceWorkspaceSnapshot };
  git: {
    scanCheckoutLoss(
      cwd: string,
      context?: { runMode?: Session['runMode']; wslDistro?: string }
    ): Promise<GitCheckoutLossEvidence>;
  };
  /** Includes active and archived records so ownership provenance can be verified. */
  listSessions(): Promise<Session[]>;
  listActiveOperationIds?(checkoutId: string): string[] | Promise<string[]>;
}

/** Conservative Device-local proof required before removing a Checkout. */
export class CheckoutLossScanner {
  constructor(private readonly options: CheckoutLossScannerOptions) {}

  async scan(checkoutId: string): Promise<CheckoutLossReport> {
    const snapshot = this.options.workspace.snapshot();
    const checkout = snapshot.checkouts.find((candidate) => candidate.id === checkoutId);
    if (!checkout) throw new Error(`Checkout not found: ${checkoutId}`);
    const [evidence, sessions, activeOperationIds] = await Promise.all([
      this.options.git.scanCheckoutLoss(checkout.path, {
        runMode: checkout.runMode,
        ...(checkout.wslDistro ? { wslDistro: checkout.wslDistro } : {})
      }),
      this.options.listSessions(),
      Promise.resolve(this.options.listActiveOperationIds?.(checkoutId) ?? [])
    ]);
    const consumers = sessions.filter((session) =>
      !session.archivedAt && session.source?.checkoutId === checkout.id
    );
    const owner = checkout.ownerSessionId
      ? sessions.find((session) => session.id === checkout.ownerSessionId)
      : undefined;
    const blockers: CheckoutLossBlocker[] = [];
    if (checkout.lifecycle !== 'ready') {
      add(blockers, 'lifecycle', 'Only a ready Checkout can enter cleanup planning.');
    }
    if (checkout.role === 'main') {
      add(blockers, 'main', 'The main Checkout can never be removed by Workspace cleanup.');
    } else if (checkout.role !== 'isolated-session') {
      add(blockers, 'role', 'Only a Session-owned isolated Checkout can be cleaned up here.');
    }
    if (!checkout.ownerSessionId || !owner || owner.source?.kind !== 'isolated-worktree'
      || owner.source.checkoutId !== checkout.id) {
      add(blockers, 'ownership', 'Isolated Checkout ownership provenance is incomplete.');
    } else if (owner.source.generatedBranch) {
      if (evidence.branchRef !== owner.source.generatedBranch || evidence.detached) {
        add(blockers, 'branch', 'The isolated Checkout Branch changed after it was created.');
      }
    } else if (!evidence.detached) {
      add(blockers, 'branch', 'The isolated detached Checkout is now on a Branch.');
    }
    if (!evidence.certain || evidence.ignored === null || evidence.unpublishedCommits === null) {
      add(blockers, 'uncertain', 'Git loss evidence is incomplete; cleanup is blocked.');
    }
    if (evidence.staged > 0) add(blockers, 'staged', 'The Checkout contains staged changes.');
    if (evidence.unstaged > 0) add(blockers, 'unstaged', 'The Checkout contains unstaged changes.');
    if (evidence.untracked > 0) add(blockers, 'untracked', 'The Checkout contains untracked files.');
    if ((evidence.ignored ?? 0) > 0) add(blockers, 'ignored', 'The Checkout contains ignored files.');
    if ((evidence.unpublishedCommits ?? 0) > 0) {
      add(blockers, 'unpublished', 'The Checkout contains commits not reachable from any remote ref.');
    }
    if (consumers.length > 0) {
      add(blockers, 'consumer', 'One or more active Sessions still consume this Checkout.');
    }
    if (activeOperationIds.length > 0) {
      add(blockers, 'operation', 'Another active operation targets this Checkout.');
    }
    return {
      checkoutId: checkout.id,
      checkoutVersion: checkout.version,
      observedAt: evidence.observedAt,
      eligible: blockers.length === 0,
      blockers,
      activeConsumerSessionIds: consumers.map((session) => session.id).sort(),
      activeOperationIds: [...activeOperationIds].sort(),
      evidence: structuredClone(evidence)
    };
  }
}

function add(
  blockers: CheckoutLossBlocker[],
  code: CheckoutLossBlocker['code'],
  message: string
): void {
  blockers.push({ code, message });
}
