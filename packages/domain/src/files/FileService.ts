import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  FilePasteRequest,
  FileOpenRequest,
  FileReadRequest,
  FileReadResult,
  FileSearchRequest,
  FileTreeRequest,
  FileTreeResult,
  FileWriteRequest,
  ImagePasteRequest,
  ImagePasteResult,
} from "../../../../shared/types/files.js";
import { effectiveAgentProvider, type Session } from "../../../../shared/types/sessions.js";
import {
  joinHostPath,
  posixToWslUnc,
  worktreeHostPath,
} from "../runtime/wsl-paths.js";
import { DomainError } from "../errors.js";
import {
  WorktreeFileIndex,
  type FileIndexScope,
} from "./WorktreeFileIndex.js";

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_PASTED_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TERMINAL_PASTE_LENGTH = 32 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export interface FilesRuntime {
  listRunning(): Promise<Array<{ terminalId: string; sessionId: string }>>;
  write(terminalId: string, data: string): Promise<unknown>;
}

export interface FileServiceOptions {
  fileIndex?: WorktreeFileIndex;
  runtime: FilesRuntime;
  getSession(sessionId: string): Promise<Session | null>;
  authorizeScope(scope: FileIndexScope): Promise<boolean>;
  getEditor?: () => Promise<string | undefined>;
  launchEditor?: (editor: string, absolutePath: string) => Promise<void>;
}

interface ResolvedRoot {
  hostRoot: string;
  realRoot: string;
  pathApi: typeof path.posix | typeof path.win32;
}

export class FileService {
  private readonly fileIndex: WorktreeFileIndex;

  constructor(private readonly options: FileServiceOptions) {
    this.fileIndex = options.fileIndex ?? new WorktreeFileIndex();
  }

  async search(request: FileSearchRequest) {
    const scope = fileIndexScope(request);
    await this.authorize(scope);
    return this.fileIndex.search(scope, request.query, request.limit);
  }

  async openInEditor(request: FileOpenRequest): Promise<true> {
    const scope = fileIndexScope(request);
    const root = await this.resolveRoot(scope);
    if (
      typeof request.absolutePath !== "string" ||
      !request.absolutePath.trim() ||
      request.absolutePath.length > 16_384 ||
      request.absolutePath.includes("\0") ||
      !root.pathApi.isAbsolute(request.absolutePath)
    ) {
      throw new DomainError(
        "invalid_file_path",
        "Editor target must be a bounded absolute path",
      );
    }
    const relativePath = root.pathApi.relative(root.hostRoot, request.absolutePath);
    if (
      root.pathApi.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${root.pathApi.sep}`)
    ) {
      throw new DomainError(
        "path_not_authorized",
        "Editor target is outside the authorized Worktree",
      );
    }
    const target = await this.resolveExisting(root, relativePath || ".");
    const editor =
      (await this.options.getEditor?.())?.trim() ||
      process.env.EDITOR?.trim() ||
      "code";
    await (this.options.launchEditor ?? launchEditor)(editor, target);
    return true;
  }

  async listTree(request: FileTreeRequest): Promise<FileTreeResult> {
    const scope = fileIndexScope(request);
    await this.authorize(scope);
    const inventory = await this.fileIndex.inventory(scope, {
      force: request.force,
    });
    return {
      cwd: request.cwd,
      paths: inventory.paths,
      truncated: inventory.truncated,
      isRepo: inventory.isRepo,
    };
  }

  async readFile(request: FileReadRequest): Promise<FileReadResult> {
    const scope = fileIndexScope(request);
    const root = await this.resolveRoot(scope);
    const relativePath = requiredRelativePath(request.relativePath);
    let absolute: string;
    try {
      absolute = await this.resolveExisting(root, relativePath);
    } catch (error) {
      if (isUnavailable(error)) {
        return unavailableRead(relativePath, unavailableReason(error));
      }
      throw error;
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      if (isUnavailable(error)) {
        return unavailableRead(relativePath, unavailableReason(error));
      }
      throw error;
    }
    if (!stat.isFile()) {
      return unavailableRead(relativePath, "not_a_regular_file", stat.size);
    }
    if (stat.size > MAX_READ_BYTES) {
      return {
        relativePath,
        content: "",
        binary: false,
        truncated: true,
        oversized: true,
        unavailable: false,
        size: stat.size,
        maxBytes: MAX_READ_BYTES,
      };
    }

    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) {
      return {
        relativePath,
        content: "",
        binary: true,
        truncated: false,
        oversized: false,
        unavailable: false,
        size: stat.size,
      };
    }
    return {
      relativePath,
      content: buffer.toString("utf8"),
      binary: false,
      truncated: false,
      oversized: false,
      unavailable: false,
      size: stat.size,
    };
  }

  async writeFile(request: FileWriteRequest): Promise<true> {
    const scope = fileIndexScope(request);
    const root = await this.resolveRoot(scope);
    const relativePath = requiredRelativePath(request.relativePath);
    const contentBytes = Buffer.byteLength(request.content, "utf8");
    if (contentBytes > MAX_WRITE_BYTES) {
      throw new DomainError(
        "request_too_large",
        `File content exceeds the ${MAX_WRITE_BYTES}-byte write limit`,
        "Save a smaller file through Soloe",
      );
    }

    const candidate = lexicalCandidate(root, relativePath);
    await assertExistingTargetInsideRoot(root, candidate);
    const parent = root.pathApi.dirname(candidate);
    await assertNearestExistingAncestorInsideRoot(root, parent);
    await fs.mkdir(parent, { recursive: true });
    await assertRealPathInsideRoot(root, parent, "path_symlink_escape");

    const temporary = `${candidate}.soloe-${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, request.content, "utf8");
    try {
      await fs.rename(temporary, candidate);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    this.fileIndex.invalidate(scope);
    return true;
  }

  async pasteIntoTerminal(request: FilePasteRequest): Promise<true> {
    const pastedPath = request.path;
    if (
      !pastedPath ||
      pastedPath.length > MAX_TERMINAL_PASTE_LENGTH ||
      /[\0\r\n]/u.test(pastedPath)
    ) {
      throw new DomainError(
        "invalid_terminal_paste",
        "Terminal file paste must be a bounded single-line path",
      );
    }
    await this.requireRunningTerminal(request.terminalId);
    await this.options.runtime.write(request.terminalId, pastedPath);
    return true;
  }

  async pasteImagesIntoTerminal(
    request: ImagePasteRequest,
  ): Promise<ImagePasteResult> {
    const session = await this.options.getSession(request.sessionId);
    if (!session) {
      throw new DomainError(
        "session_not_found",
        `Session not found: ${request.sessionId}`,
      );
    }
    if (effectiveAgentProvider(session) === null) {
      throw new DomainError(
        "invalid_session",
        "Image paste is only available for Claude and Codex sessions",
      );
    }
    const terminal = await this.requireRunningTerminal(request.terminalId);
    if (terminal.sessionId !== session.id) {
      throw new DomainError(
        "terminal_session_mismatch",
        "The terminal does not belong to the requested Session",
      );
    }
    if (request.images.length === 0 || request.images.length > MAX_PASTED_IMAGES) {
      throw new DomainError(
        "invalid_image_count",
        `Image paste requires between 1 and ${MAX_PASTED_IMAGES} images`,
      );
    }

    const safeSessionId = session.id.replace(/[^a-zA-Z0-9_.-]/gu, "-");
    const providerDirectory =
      session.runMode === "wsl"
        ? `/tmp/soloe-images/${safeSessionId}`
        : path.join(os.tmpdir(), "soloe-images", safeSessionId);
    if (session.runMode === "wsl" && process.platform === "win32" && !session.wslDistro) {
      throw new DomainError(
        "invalid_wsl_distribution",
        "A WSL distribution is required for image paste",
      );
    }
    const writeDirectory =
      session.runMode === "wsl" && process.platform === "win32"
        ? posixToWslUnc(session.wslDistro!, providerDirectory)
        : providerDirectory;
    await fs.mkdir(writeDirectory, { recursive: true });
    const paths: string[] = [];
    for (let index = 0; index < request.images.length; index += 1) {
      const image = request.images[index]!;
      const mimeType = image.mimeType.toLowerCase();
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        throw new DomainError(
          "invalid_image_type",
          `Unsupported clipboard image type: ${image.mimeType}`,
        );
      }
      const buffer = decodeBase64(image.dataBase64);
      if (buffer.length === 0) {
        throw new DomainError("invalid_image", "Clipboard image was empty");
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new DomainError(
          "request_too_large",
          `Clipboard image exceeds the ${MAX_IMAGE_BYTES}-byte limit`,
        );
      }
      const filename =
        `${Date.now()}-${index + 1}-${randomBytes(3).toString("hex")}.` +
        extensionForMime(mimeType);
      const absolutePath = joinHostPath(writeDirectory, filename);
      await fs.writeFile(absolutePath, buffer);
      paths.push(
        session.runMode === "wsl"
          ? `${providerDirectory}/${filename}`
          : absolutePath,
      );
    }

    const insertedText = `${paths.join(" ")} `;
    await this.options.runtime.write(request.terminalId, insertedText);
    return { paths, insertedText };
  }

  dispose(): void {
    this.fileIndex.dispose();
  }

  private async authorize(scope: FileIndexScope): Promise<void> {
    if (!(await this.options.authorizeScope(scope))) {
      throw new DomainError(
        "worktree_not_authorized",
        "The requested Worktree is not registered with this Soloe backend",
        "Open the Project or select a Session for this Worktree first",
      );
    }
  }

  private async resolveRoot(scope: FileIndexScope): Promise<ResolvedRoot> {
    await this.authorize(scope);
    const hostRoot = worktreeHostPath(scope.cwd, scope.runMode, scope.wslDistro);
    const pathApi = pathApiFor(hostRoot);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(hostRoot);
      const stat = await fs.stat(realRoot);
      if (!stat.isDirectory()) {
        throw new DomainError(
          "worktree_unavailable",
          "The requested Worktree root is not a directory",
        );
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "worktree_unavailable",
        "The requested Worktree root is unavailable",
      );
    }
    return { hostRoot: pathApi.resolve(hostRoot), realRoot, pathApi };
  }

  private async resolveExisting(
    root: ResolvedRoot,
    relativePath: string,
  ): Promise<string> {
    const candidate = lexicalCandidate(root, relativePath);
    const resolved = await fs.realpath(candidate);
    assertInside(root, resolved, "path_symlink_escape");
    return resolved;
  }

  private async requireRunningTerminal(terminalId: string) {
    const terminal = (await this.options.runtime.listRunning()).find(
      (candidate) => candidate.terminalId === terminalId,
    );
    if (!terminal) {
      throw new DomainError(
        "terminal_not_found",
        `Runtime-owned terminal not found: ${terminalId}`,
      );
    }
    return terminal;
  }
}

function fileIndexScope(
  request: Pick<FileTreeRequest, "cwd" | "runMode" | "wslDistro">,
): FileIndexScope {
  const cwd = request.cwd?.trim();
  if (!cwd) throw new DomainError("invalid_worktree", "cwd is required");
  if (!["linux", "windows", "wsl"].includes(request.runMode)) {
    throw new DomainError("invalid_worktree", "runMode is invalid");
  }
  if (request.runMode === "wsl" && !request.wslDistro?.trim() && process.platform === "win32") {
    throw new DomainError(
      "invalid_wsl_distribution",
      "A WSL distribution is required for this Worktree",
    );
  }
  return {
    cwd,
    runMode: request.runMode,
    ...(request.wslDistro?.trim()
      ? { wslDistro: request.wslDistro.trim() }
      : {}),
  };
}

function requiredRelativePath(value: string): string {
  if (!value?.trim()) {
    throw new DomainError("invalid_path", "relativePath is required");
  }
  if (value.includes("\0")) {
    throw new DomainError("invalid_path", "Paths cannot contain NUL bytes");
  }
  return value;
}

function lexicalCandidate(root: ResolvedRoot, relativePath: string): string {
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new DomainError("absolute_path_forbidden", "Absolute paths are not allowed");
  }
  const candidate = root.pathApi.resolve(root.hostRoot, relativePath);
  assertInside(
    { ...root, realRoot: root.hostRoot },
    candidate,
    "path_traversal",
  );
  return candidate;
}

function assertInside(
  root: ResolvedRoot,
  candidate: string,
  code: "path_traversal" | "path_symlink_escape",
): void {
  const relative = root.pathApi.relative(root.realRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${root.pathApi.sep}`) ||
    root.pathApi.isAbsolute(relative)
  ) {
    throw new DomainError(
      code,
      code === "path_traversal"
        ? "Path escapes the Worktree root"
        : "Path resolves through a symlink outside the Worktree root",
    );
  }
}

async function assertRealPathInsideRoot(
  root: ResolvedRoot,
  target: string,
  code: "path_symlink_escape",
): Promise<void> {
  const real = await fs.realpath(target);
  assertInside(root, real, code);
}

async function assertExistingTargetInsideRoot(
  root: ResolvedRoot,
  candidate: string,
): Promise<void> {
  try {
    await assertRealPathInsideRoot(root, candidate, "path_symlink_escape");
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }
}

async function assertNearestExistingAncestorInsideRoot(
  root: ResolvedRoot,
  target: string,
): Promise<void> {
  let current = target;
  while (true) {
    try {
      await assertRealPathInsideRoot(root, current, "path_symlink_escape");
      return;
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
    const parent = root.pathApi.dirname(current);
    if (parent === current) {
      throw new DomainError(
        "path_symlink_escape",
        "No safe parent exists inside the Worktree root",
      );
    }
    current = parent;
  }
}

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return value.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/u.test(value)
    ? path.win32
    : path.posix;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function launchEditor(editor: string, absolutePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [absolutePath], {
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

function unavailableRead(
  relativePath: string,
  reason: string,
  size = 0,
): FileReadResult {
  return {
    relativePath,
    content: "",
    binary: false,
    truncated: false,
    oversized: false,
    unavailable: true,
    unavailableReason: reason,
    size,
  };
}

function unavailableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "unavailable";
}

function isUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM";
}

function decodeBase64(value: string): Buffer {
  if (!value || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new DomainError("invalid_image", "Clipboard image data is not valid base64");
  }
  return Buffer.from(value, "base64");
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return "png";
}
