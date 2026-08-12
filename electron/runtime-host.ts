import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  NodePtyRuntimeProcessFactory,
  prepareRuntimeEndpoint,
  removeServiceInfo,
  resolveRuntimeEndpoint,
  resolveSoloeDataDirectory,
  RuntimeHost,
  secureRuntimeEndpoint,
  writeServiceInfo
} from '@soloe/runtime';

async function main(): Promise<void> {
  const dataDirectory = resolveSoloeDataDirectory();
  const ownerId = process.env.SOLOE_OWNER_ID;
  const endpoint =
    process.env.SOLOE_RUNTIME_ENDPOINT ?? resolveRuntimeEndpoint({ dataDirectory });
  if (process.platform !== 'win32') {
    await mkdir(path.dirname(endpoint), { recursive: true });
  }
  await prepareRuntimeEndpoint(endpoint);

  const runtime = new RuntimeHost({
    endpoint,
    processFactory: new NodePtyRuntimeProcessFactory()
  });
  await runtime.listen();
  await secureRuntimeEndpoint(endpoint);
  await writeServiceInfo(dataDirectory, {
    service: 'runtime',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(ownerId ? { ownerId } : {}),
    endpoint
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.shutdown();
    await removeServiceInfo(dataDirectory, 'runtime', process.pid, ownerId);
    process.exitCode = 0;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error('[runtime] failed to start packaged Environment Runtime', error);
  process.exitCode = 1;
});
