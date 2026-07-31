import { execFile, spawn } from "node:child_process";
import type { Session, SessionId } from "@shared/types/sessions.js";

export type BackendPathPlacement = "windows" | "wsl" | "linux" | "macos";

export interface BackendPathServiceOptions {
  getSession(sessionId: SessionId): Promise<Session | null>;
  placement?: BackendPathPlacement;
  launch?: (placement: BackendPathPlacement, targetPath: string) => Promise<void>;
}

export class BackendPathService {
  private readonly placement: BackendPathPlacement;
  private readonly launch: (
    placement: BackendPathPlacement,
    targetPath: string,
  ) => Promise<void>;

  constructor(private readonly options: BackendPathServiceOptions) {
    this.placement = options.placement ?? detectPathPlacement();
    this.launch = options.launch ?? launchBackendPath;
  }

  async openSessionPath(sessionId: SessionId): Promise<true> {
    if (
      typeof sessionId !== "string" ||
      !sessionId.trim() ||
      sessionId.length > 256 ||
      sessionId.includes("\0") ||
      /[\\/]/u.test(sessionId)
    ) {
      throw new BackendPathError(
        "invalid_session_id",
        "Session id must be a bounded string",
      );
    }
    const session = await this.options.getSession(sessionId);
    if (!session) {
      throw new BackendPathError(
        "session_not_found",
        "The selected session no longer exists",
      );
    }
    await this.launch(this.placement, session.cwd);
    return true;
  }
}

export class BackendPathError extends Error {
  constructor(
    readonly code: "invalid_session_id" | "session_not_found" | "path_open_failed",
    message: string,
  ) {
    super(message);
    this.name = "BackendPathError";
  }
}

export function detectPathPlacement(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): BackendPathPlacement {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return environment.WSL_DISTRO_NAME?.trim() ? "wsl" : "linux";
}

async function launchBackendPath(
  placement: BackendPathPlacement,
  targetPath: string,
): Promise<void> {
  try {
    if (placement === "wsl") {
      const windowsPath = await translateWslPath(targetPath);
      await spawnDetached("explorer.exe", [windowsPath]);
      return;
    }
    if (placement === "windows") {
      await spawnDetached("explorer.exe", [targetPath]);
      return;
    }
    if (placement === "macos") {
      await spawnDetached("open", [targetPath]);
      return;
    }
    await spawnDetached("xdg-open", [targetPath]);
  } catch {
    throw new BackendPathError(
      "path_open_failed",
      "The backend could not open the selected session directory",
    );
  }
}

function translateWslPath(targetPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "wslpath",
      ["-w", targetPath],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 16_384,
        windowsHide: true,
      },
      (error, stdout) => {
        const translated = stdout.trim();
        if (error || !translated) {
          reject(error ?? new Error("wslpath returned an empty path"));
          return;
        }
        resolve(translated);
      },
    );
  });
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
