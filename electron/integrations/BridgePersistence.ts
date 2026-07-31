import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface BridgeConfig {
  port: number;
  token: string;
}

// Persists the MCP bridge port + token across Soloe restarts so the values can
// be written as literals into agent config files (Claude/Codex MCP entries).
// Without this, every Soloe boot picks a fresh random port and a fresh token,
// which would invalidate any MCP server entry the HookInstaller wrote earlier.
export class BridgePersistence {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BridgeConfig | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const port = typeof obj['port'] === 'number' && Number.isInteger(obj['port']) ? obj['port'] : null;
      const token = typeof obj['token'] === 'string' && obj['token'].length > 0 ? obj['token'] : null;
      if (port === null || token === null) return null;
      return { port, token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  async save(config: BridgeConfig): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => {});
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600
    });
    await fs.rename(tmp, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => {});
  }

  async loadOrCreate(): Promise<BridgeConfig> {
    const existing = await this.load();
    if (existing) return existing;
    const fresh: BridgeConfig = { port: 0, token: randomBytes(24).toString('hex') };
    await this.save(fresh);
    return fresh;
  }
}
