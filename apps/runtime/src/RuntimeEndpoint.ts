import { homedir, userInfo } from "node:os";
import path from "node:path";

export interface RuntimeEndpointOptions {
  platform?: NodeJS.Platform;
  dataDirectory?: string;
  userIdentity?: string;
}

export function resolveRuntimeEndpoint(options: RuntimeEndpointOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const identity = (options.userIdentity ?? userInfo().username)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return `\\\\.\\pipe\\soloe-runtime-${identity || "user"}`;
  }
  return path.join(options.dataDirectory ?? resolveSoloeDataDirectory(platform), "runtime.sock");
}

export function resolveSoloeDataDirectory(
  platform: NodeJS.Platform = process.platform,
): string {
  if (process.env.SOLOE_DATA_DIR) return process.env.SOLOE_DATA_DIR;
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Soloe");
  }
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? homedir(), "Soloe");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "soloe");
}
