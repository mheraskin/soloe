import { startServerHost } from '../apps/server/src/ServerHost.js';

async function main(): Promise<void> {
  const host = await startServerHost();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await host.close();
    process.exitCode = 0;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error('[server] failed to start packaged Soloe application server', error);
  process.exitCode = 1;
});
