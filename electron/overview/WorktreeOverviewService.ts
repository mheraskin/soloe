import type { spawn } from "node:child_process";
import {
  WorktreeOverviewService as SharedWorktreeOverviewService,
  type WorktreeOverviewServiceOptions as SharedWorktreeOverviewServiceOptions,
} from "../../packages/domain/src/overview/WorktreeOverviewService.js";
import { BackgroundAgentExecution } from "../agents/BackgroundAgentExecution.js";

export * from "../../packages/domain/src/overview/WorktreeOverviewService.js";

export interface WorktreeOverviewServiceOptions
  extends Omit<SharedWorktreeOverviewServiceOptions, "execution"> {
  spawnImpl?: typeof spawn;
  execution?: BackgroundAgentExecution;
}

export class WorktreeOverviewService extends SharedWorktreeOverviewService {
  constructor(options: WorktreeOverviewServiceOptions) {
    super({
      ...options,
      execution:
        options.execution ??
        new BackgroundAgentExecution({
          ...(options.spawnImpl
            ? {
                spawnImpl: options.spawnImpl,
                isExecutableAvailable: async () => true,
              }
            : {}),
        }),
    });
  }
}
