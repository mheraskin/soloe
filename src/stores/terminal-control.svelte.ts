import type {
  TerminalControllerIdentity,
  TerminalInputLease
} from '@shared/types/terminal.js';
import { ipc } from '../lib/ipc';
import {
  resolveTerminalControllerIdentity,
  TerminalControlCoordinator,
  type TerminalControlBackend
} from '../lib/terminal-control';
import { deviceSessions } from './device-sessions.svelte';

class TerminalControlStore {
  private version = $state(0);
  private coordinator: TerminalControlCoordinator | null = null;

  private control(): TerminalControlCoordinator {
    if (this.coordinator) return this.coordinator;
    const backend: TerminalControlBackend = {
      acquire: (terminalId, identity, takeover) =>
        ipc.terminal.acquireInputLease(terminalId, identity, takeover),
      current: (terminalId) => ipc.terminal.currentInputLease(terminalId),
      release: (terminalId, control) => ipc.terminal.releaseInputLease(terminalId, control),
      park: (terminalId, control) => ipc.terminal.parkInputLease(terminalId, control),
      input: async (terminalId, data, control) => {
        await ipc.terminal.input(terminalId, data, control);
      },
      resize: async (terminalId, cols, rows, control) => {
        await ipc.terminal.resize(terminalId, cols, rows, control);
      },
      onLease: (listener) => ipc.terminal.onInputLease(listener)
    };
    const coordinator = new TerminalControlCoordinator(backend, controllerIdentity);
    this.coordinator = coordinator;
    coordinator.subscribe(() => {
      this.version += 1;
    });
    if (typeof document !== 'undefined') {
      const updateVisibility = () => {
        void coordinator.setPageVisible(document.visibilityState === 'visible');
      };
      document.addEventListener('visibilitychange', updateVisibility);
      updateVisibility();
    }
    return coordinator;
  }

  lease(terminalId: string): TerminalInputLease | null {
    void this.version;
    return this.control().lease(terminalId);
  }

  owns(terminalId: string): boolean {
    void this.version;
    return this.control().owns(terminalId);
  }

  takingOver(terminalId: string): boolean {
    void this.version;
    return this.control().isTakingOver(terminalId);
  }

  select(terminalId: string): Promise<void> {
    return this.control().select(terminalId);
  }

  release(terminalId: string): Promise<void> {
    return this.control().release(terminalId);
  }

  takeover(terminalId: string): Promise<boolean> {
    return this.control().takeover(terminalId);
  }

  refresh(terminalId: string): Promise<TerminalInputLease | null> {
    return this.control().refresh(terminalId);
  }

  input(terminalId: string, data: string): Promise<void> {
    return this.control().input(terminalId, data);
  }

  resize(
    terminalId: string,
    cols: number,
    rows: number,
    options: { force?: boolean } = {}
  ): Promise<void> {
    return this.control().resize(terminalId, cols, rows, options);
  }
}

function controllerIdentity(): TerminalControllerIdentity {
  if (typeof window === 'undefined') {
    return resolveTerminalControllerIdentity(deviceSessions.localDevice, {
      deviceId: 'server-renderer',
      deviceName: 'Soloe client'
    });
  }
  const storageKey = 'soloe-terminal-controller-device-id';
  let deviceId: string | null = null;
  try {
    deviceId = window.localStorage.getItem(storageKey);
  } catch {
    // Sandboxed and privacy-restricted clients still receive an in-memory identity.
  }
  if (!deviceId) {
    deviceId = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}`;
    try {
      window.localStorage.setItem(storageKey, deviceId);
    } catch {
      // The generated identity remains valid for this page lifetime.
    }
  }
  const deviceName = navigator.platform || 'Soloe client';
  return resolveTerminalControllerIdentity(deviceSessions.localDevice, { deviceId, deviceName });
}

export const terminalControl = new TerminalControlStore();
