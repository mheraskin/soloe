<script lang="ts">
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import DeviceTerminalViewer from '../DeviceTerminalViewer.svelte';

  let projection = $state(createProjection());

  export function refreshSameTerminal(): void {
    projection = {
      ...projection,
      available: !projection.available,
      runtime: projection.runtime ? { ...projection.runtime } : null
    };
  }

  function createProjection(): MultiDeviceSessionView {
    return {
      ref: { deviceId: 'device-xps', sessionId: 'session-1' },
      key: 'device-xps/session-1',
      deviceName: 'xps',
      available: true,
      session: {
        id: 'session-1',
        name: 'Remote Claude',
        cwd: '/home/me/project',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' },
        createdAt: '2026-08-21T00:00:00.000Z',
        lastUsedAt: '2026-08-21T00:00:00.000Z'
      },
      lifecycleStatus: 'running',
      runtime: {
        sessionId: 'session-1',
        terminalId: 'terminal-1',
        status: 'running'
      },
      observation: null
    };
  }
</script>

<DeviceTerminalViewer {projection} onClose={() => undefined} />
