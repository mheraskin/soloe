import { promises as fs } from 'node:fs';
import { joinHostPath } from '../runtime/wsl-paths.js';

export interface UntrackedFileMeasurement {
  lines: number;
  binary: boolean;
}

interface CachedMeasurement extends UntrackedFileMeasurement {
  size: number;
  mtimeMs: number;
  mode: number;
}

const DEFAULT_CONCURRENCY = 4;
const READ_BUFFER_BYTES = 64 * 1024;
// Git's default binary heuristic examines the first 8,000 bytes for NUL.
const BINARY_PROBE_BYTES = 8_000;

/**
 * Measures untracked files without spawning one Git process per path.
 *
 * The Module owns bounded filesystem concurrency and a metadata-keyed cache;
 * callers only provide one host-visible worktree root and Git's relative paths.
 * Unreadable or unusual paths are omitted so the Git Adapter can retain its
 * slower, authoritative fallback for those individual files.
 */
export class UntrackedFileCounter {
  private readonly cacheByRoot = new Map<string, Map<string, CachedMeasurement>>();

  constructor(private readonly concurrency = DEFAULT_CONCURRENCY) {}

  async measure(
    rootPath: string,
    relativePaths: readonly string[]
  ): Promise<Map<string, UntrackedFileMeasurement>> {
    const paths = Array.from(new Set(relativePaths.filter(Boolean)));
    const results = new Map<string, UntrackedFileMeasurement>();
    if (!rootPath || paths.length === 0) {
      if (rootPath) this.cacheByRoot.delete(rootPath);
      return results;
    }

    const rootCache = this.cacheByRoot.get(rootPath) ?? new Map<string, CachedMeasurement>();
    this.cacheByRoot.set(rootPath, rootCache);
    const wanted = new Set(paths);
    for (const cachedPath of rootCache.keys()) {
      if (!wanted.has(cachedPath)) rootCache.delete(cachedPath);
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const relativePath = paths[cursor++]!;
        const measured = await this.measureOne(rootPath, relativePath, rootCache);
        if (measured) results.set(relativePath, measured);
      }
    };
    const workerCount = Math.min(
      paths.length,
      Math.max(1, Math.trunc(this.concurrency) || DEFAULT_CONCURRENCY)
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  clear(): void {
    this.cacheByRoot.clear();
  }

  clearRoot(rootPath: string): void {
    this.cacheByRoot.delete(rootPath);
  }

  private async measureOne(
    rootPath: string,
    relativePath: string,
    rootCache: Map<string, CachedMeasurement>
  ): Promise<UntrackedFileMeasurement | null> {
    const absolutePath = joinHostPath(rootPath, relativePath);
    try {
      const stat = await fs.lstat(absolutePath);
      const cached = rootCache.get(relativePath);
      if (
        cached &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.mode === stat.mode
      ) {
        return { lines: cached.lines, binary: cached.binary };
      }

      let measured: UntrackedFileMeasurement | null;
      if (stat.isSymbolicLink()) {
        // Git stores the link target as the blob contents. It is one logical
        // line unless the target itself is empty.
        const target = await fs.readlink(absolutePath);
        measured = { lines: target.length > 0 ? 1 : 0, binary: false };
      } else if (stat.isFile()) {
        measured = await measureRegularFile(absolutePath);
      } else {
        measured = null;
      }
      if (!measured) return null;
      rootCache.set(relativePath, {
        ...measured,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode
      });
      return measured;
    } catch {
      rootCache.delete(relativePath);
      return null;
    }
  }
}

async function measureRegularFile(filePath: string): Promise<UntrackedFileMeasurement> {
  const handle = await fs.open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let position = 0;
  let newlineCount = 0;
  let lastByte = -1;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index++) {
        const byte = buffer[index]!;
        if (position + index < BINARY_PROBE_BYTES && byte === 0) {
          return { lines: 0, binary: true };
        }
        if (byte === 10) newlineCount += 1;
        lastByte = byte;
      }
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    lines: newlineCount + (position > 0 && lastByte !== 10 ? 1 : 0),
    binary: false
  };
}
