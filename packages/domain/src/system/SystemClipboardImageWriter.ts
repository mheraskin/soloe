import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClipboardImageWriter } from "../files/FileService.js";
import { DomainError } from "../errors.js";

export interface ClipboardCommandRunner {
  run(command: string, args: string[], input?: Buffer | string): Promise<void>;
}

export interface SystemClipboardImageWriterOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  commands?: ClipboardCommandRunner;
}

export class SystemClipboardImageWriter implements ClipboardImageWriter {
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly commands: ClipboardCommandRunner;

  constructor(options: SystemClipboardImageWriterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.commands = options.commands ?? { run: runClipboardCommand };
  }

  async writeImage(image: { mimeType: string; data: Buffer }): Promise<void> {
    try {
      if (this.platform === "win32" || this.environment.WSL_DISTRO_NAME?.trim()) {
        await this.writeWindowsImage(image.data);
        return;
      }
      if (this.platform === "darwin") {
        await this.writeMacImage(image);
        return;
      }
      await this.writeLinuxImage(image);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "clipboard_unavailable",
        "The owning Device could not place the image on its native clipboard",
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private async writeWindowsImage(data: Buffer): Promise<void> {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
      "$stream = [IO.MemoryStream]::new($bytes)",
      "$source = [Drawing.Image]::FromStream($stream)",
      "$bitmap = [Drawing.Bitmap]::new($source)",
      "[Windows.Forms.Clipboard]::SetImage($bitmap)",
      "$bitmap.Dispose(); $source.Dispose(); $stream.Dispose()",
    ].join("; ");
    await this.commands.run(
      "powershell.exe",
      ["-Sta", "-NoProfile", "-NonInteractive", "-Command", script],
      data.toString("base64"),
    );
  }

  private async writeLinuxImage(image: { mimeType: string; data: Buffer }): Promise<void> {
    const attempts: Array<[string, string[]]> = this.environment.WAYLAND_DISPLAY?.trim()
      ? [
          ["wl-copy", ["--type", image.mimeType]],
          ["xclip", ["-selection", "clipboard", "-t", image.mimeType, "-i"]],
        ]
      : [
          ["xclip", ["-selection", "clipboard", "-t", image.mimeType, "-i"]],
          ["wl-copy", ["--type", image.mimeType]],
        ];
    let lastError: unknown;
    for (const [command, args] of attempts) {
      try {
        await this.commands.run(command, args, image.data);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("No supported native clipboard command is installed");
  }

  private async writeMacImage(image: { mimeType: string; data: Buffer }): Promise<void> {
    const clipboardClass = macClipboardClass(image.mimeType);
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-clipboard-"));
    const imagePath = path.join(directory, "image");
    try {
      await writeFile(imagePath, image.data);
      await this.commands.run("osascript", [
        "-e", "on run argv",
        "-e", "set imageFile to POSIX file (item 1 of argv)",
        "-e", `set the clipboard to (read imageFile as «class ${clipboardClass}»)`,
        "-e", "end run",
        imagePath,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function macClipboardClass(mimeType: string): string {
  if (mimeType === "image/png") return "PNGf";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "JPEG";
  if (mimeType === "image/gif") return "GIFf";
  throw new DomainError(
    "invalid_image_type",
    `The macOS native clipboard does not support ${mimeType}`,
  );
}

function runClipboardCommand(
  command: string,
  args: string[],
  input?: Buffer | string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 16_384) {
        stderr.push(chunk);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} exited with code ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      ));
    });
    child.stdin.once("error", reject);
    child.stdin.end(input);
  });
}
