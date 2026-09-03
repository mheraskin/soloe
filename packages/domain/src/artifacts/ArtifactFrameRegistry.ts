import { randomUUID } from 'node:crypto';
import { ArtifactStoreError, MAX_ARTIFACT_HTML_BYTES } from './ArtifactStore.js';

const ARTIFACT_FRAME_TOKEN_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const DEFAULT_ARTIFACT_FRAME_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_ARTIFACT_FRAME_ENTRIES = 8;
const DEFAULT_ARTIFACT_FRAME_TOTAL_BYTES = MAX_ARTIFACT_HTML_BYTES * 2;

export const ARTIFACT_FRAME_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts'
].join('; ');

export interface ArtifactFrameTicket {
  token: string;
}

export interface ArtifactFrameRegistryOptions {
  now?: () => number;
  createToken?: () => string;
  ttlMs?: number;
  maxEntries?: number;
  maxHtmlBytes?: number;
  maxTotalBytes?: number;
}

interface ArtifactFrameEntry {
  html: string;
  bytes: number;
  expiresAt: number;
}

export class ArtifactFrameRegistry {
  private readonly entries = new Map<string, ArtifactFrameEntry>();
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxHtmlBytes: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;

  constructor(options: ArtifactFrameRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? randomUUID;
    this.ttlMs = options.ttlMs ?? DEFAULT_ARTIFACT_FRAME_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_ARTIFACT_FRAME_ENTRIES;
    this.maxHtmlBytes = options.maxHtmlBytes ?? MAX_ARTIFACT_HTML_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_ARTIFACT_FRAME_TOTAL_BYTES;
  }

  issue(html: string): ArtifactFrameTicket {
    if (typeof html !== 'string' || html.length === 0 || html.includes('\0')) {
      throw new ArtifactStoreError(
        'invalid_artifact_html',
        'Artifact frame HTML must be a non-empty string without null bytes'
      );
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > this.maxHtmlBytes || bytes > this.maxTotalBytes) {
      throw new ArtifactStoreError(
        'artifact_too_large',
        `Artifact HTML exceeds the ${Math.min(this.maxHtmlBytes, this.maxTotalBytes)}-byte frame limit`
      );
    }
    this.pruneExpired();
    const token = this.createToken();
    if (!ARTIFACT_FRAME_TOKEN_PATTERN.test(token) || this.entries.has(token)) {
      throw new Error('Artifact frame token generator returned an invalid or duplicate token');
    }
    this.entries.set(token, {
      html,
      bytes,
      expiresAt: this.now() + this.ttlMs
    });
    this.totalBytes += bytes;
    this.pruneCapacity();
    return { token };
  }

  read(token: string): string | null {
    if (!ARTIFACT_FRAME_TOKEN_PATTERN.test(token)) return null;
    this.pruneExpired();
    return this.entries.get(token)?.html ?? null;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.remove(token, entry);
    }
  }

  private pruneCapacity(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) return;
      this.remove(oldest[0], oldest[1]);
    }
  }

  private remove(token: string, entry: ArtifactFrameEntry): void {
    if (!this.entries.delete(token)) return;
    this.totalBytes -= entry.bytes;
  }
}
