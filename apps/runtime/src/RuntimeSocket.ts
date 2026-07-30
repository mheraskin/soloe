import { chmod, rm } from "node:fs/promises";
import { RuntimeClient } from "./RuntimeClient.js";

export async function prepareRuntimeEndpoint(
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  try {
    const client = await RuntimeClient.connect(endpoint);
    client.disconnect();
    throw new RuntimeAlreadyRunningError(endpoint);
  } catch (error) {
    if (error instanceof RuntimeAlreadyRunningError) throw error;
    await rm(endpoint, { force: true });
  }
}

export async function secureRuntimeEndpoint(
  endpoint: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") {
    await chmod(endpoint, 0o600);
  }
}

export class RuntimeAlreadyRunningError extends Error {
  constructor(endpoint: string) {
    super(`Environment Runtime is already listening at ${endpoint}`);
  }
}
