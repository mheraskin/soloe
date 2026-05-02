import type { AgentIntegrationStatus } from '@shared/types/ipc.js';

class AgentIntegrationSetupStore {
  open = $state(false);
  status = $state<AgentIntegrationStatus | null>(null);
  projectPath = $state<string | undefined>(undefined);

  show(status: AgentIntegrationStatus, projectPath?: string): void {
    this.status = status;
    this.projectPath = projectPath;
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  update(status: AgentIntegrationStatus): void {
    this.status = status;
  }
}

export const agentIntegrationSetup = new AgentIntegrationSetupStore();
