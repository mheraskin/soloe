import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  BrowserSessionScopeState,
  BrowserSessionSnapshot,
  BrowserSessionTab,
  BrowserSessionUpdateRequest,
  BrowserTabDevice
} from '@shared/types/browser-sessions.js';

const STORAGE_VERSION = 1;
const MAX_SCOPES = 64;
const MAX_TABS = 24;
const MAX_HISTORY = 100;
const MAX_URL_CHARS = 8_192;
const MAX_TITLE_CHARS = 512;
const MAX_SCOPE_CHARS = 256 * 1024;
const MAX_TOTAL_CHARS = 4 * 1024 * 1024;
const MAX_SCOPE_KEY_CHARS = 16_384;

const EMPTY_SNAPSHOT: BrowserSessionSnapshot = {
  version: STORAGE_VERSION,
  scopeRecency: [],
  scopes: {}
};

export class BrowserSessionStore {
  private cache: BrowserSessionSnapshot | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.cache) return;
    this.cache = await this.loadFromDisk();
  }

  async get(): Promise<BrowserSessionSnapshot> {
    await this.ensureLoaded();
    return clone(this.cache!);
  }

  async update(request: BrowserSessionUpdateRequest): Promise<true> {
    await this.ensureLoaded();
    const scopeKey = validateScopeKey(request?.scopeKey);
    const state = compactScope(sanitizeState(request?.state));
    const scopes = { ...this.cache!.scopes, [scopeKey]: state };
    const scopeRecency = [
      ...this.cache!.scopeRecency.filter((candidate) => candidate !== scopeKey),
      scopeKey
    ];
    this.cache = boundSnapshot({ version: STORAGE_VERSION, scopes, scopeRecency });
    await this.persist();
    return true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.cache) await this.init();
  }

  private async loadFromDisk(): Promise<BrowserSessionSnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return clone(EMPTY_SNAPSHOT);
      throw error;
    }
    try {
      return parseSnapshot(JSON.parse(raw));
    } catch {
      await this.backupCorruptFile(raw);
      return clone(EMPTY_SNAPSHOT);
    }
  }

  private async backupCorruptFile(content: string): Promise<void> {
    try {
      await fs.writeFile(`${this.filePath}.corrupt-${Date.now()}`, content, 'utf8');
    } catch {
      // A corrupt state file must not prevent the application from starting.
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.cache!, null, 2);
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.filePath, payload));
    await this.writeQueue;
  }
}

function parseSnapshot(value: unknown): BrowserSessionSnapshot {
  if (!isObject(value)) return clone(EMPTY_SNAPSHOT);
  const rawScopes = isObject(value['scopes']) ? value['scopes'] : {};
  const scopes: Record<string, BrowserSessionScopeState> = {};
  for (const [key, state] of Object.entries(rawScopes)) {
    if (!isScopeKey(key)) continue;
    scopes[key] = compactScope(sanitizeState(state));
  }
  const rawRecency = Array.isArray(value['scopeRecency']) ? value['scopeRecency'] : [];
  const scopeRecency = rawRecency.filter(
    (key): key is string => typeof key === 'string' && key in scopes
  );
  for (const key of Object.keys(scopes)) {
    if (!scopeRecency.includes(key)) scopeRecency.push(key);
  }
  return boundSnapshot({ version: STORAGE_VERSION, scopes, scopeRecency });
}

function boundSnapshot(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
  const scopes = { ...snapshot.scopes };
  const scopeRecency = [...new Set(snapshot.scopeRecency)].filter((key) => key in scopes);
  while (scopeRecency.length > MAX_SCOPES) {
    const oldest = scopeRecency.shift();
    if (oldest) delete scopes[oldest];
  }
  while (scopeRecency.length > 1 && serializedScopesLength(scopes) > MAX_TOTAL_CHARS) {
    const oldest = scopeRecency.shift();
    if (oldest) delete scopes[oldest];
  }
  return { version: STORAGE_VERSION, scopes, scopeRecency };
}

function sanitizeState(value: unknown): BrowserSessionScopeState {
  if (!isObject(value)) return { tabs: [], activeTabId: null };
  const seen = new Set<string>();
  let tabs = Array.isArray(value['tabs'])
    ? value['tabs'].map(sanitizeTab).filter((tab): tab is BrowserSessionTab => {
        if (!tab || seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
      })
    : [];
  const rawActive = typeof value['activeTabId'] === 'string' ? value['activeTabId'] : null;
  if (tabs.length > MAX_TABS) {
    const active = rawActive ? tabs.find((tab) => tab.id === rawActive) : undefined;
    tabs = tabs.slice(-MAX_TABS);
    if (active && !tabs.some((tab) => tab.id === active.id)) {
      tabs = [active, ...tabs.slice(1)];
    }
  }
  const activeTabId = rawActive && tabs.some((tab) => tab.id === rawActive)
    ? rawActive
    : tabs[0]?.id ?? null;
  if (activeTabId) {
    tabs = tabs.map((tab) => {
      if (tab.id !== activeTabId || tab.pausedAt === undefined) return tab;
      const { pausedAt: _pausedAt, ...resumed } = tab;
      return resumed;
    });
  }
  return { tabs, activeTabId };
}

function sanitizeTab(value: unknown): BrowserSessionTab | null {
  if (!isObject(value)) return null;
  if (typeof value['id'] !== 'string' || !value['id'] || value['id'].length > 256) return null;
  if (!Array.isArray(value['history']) || !value['history'].every((url) => typeof url === 'string')) {
    return null;
  }
  if (value['history'].length === 0 || !Number.isInteger(value['historyIndex'])) return null;
  const rawIndex = value['historyIndex'] as number;
  if (rawIndex < 0 || rawIndex >= value['history'].length) return null;
  const historyStart = Math.max(0, value['history'].length - MAX_HISTORY);
  const history = (value['history'] as string[])
    .slice(historyStart)
    .map((url) => url.slice(0, MAX_URL_CHARS));
  const device = sanitizeDevice(value['device']);
  const pageZoom = sanitizeZoom(value['pageZoom']);
  const canvasZoom = sanitizeZoom(value['canvasZoom']);
  const pausedAt = typeof value['pausedAt'] === 'number' && Number.isFinite(value['pausedAt'])
    ? value['pausedAt']
    : undefined;
  return {
    id: value['id'],
    title: typeof value['title'] === 'string'
      ? value['title'].slice(0, MAX_TITLE_CHARS)
      : history[Math.max(0, rawIndex - historyStart)] ?? '',
    history,
    historyIndex: Math.max(0, Math.min(history.length - 1, rawIndex - historyStart)),
    ...(device ? { device } : {}),
    ...(pageZoom !== undefined ? { pageZoom } : {}),
    ...(canvasZoom !== undefined ? { canvasZoom } : {}),
    ...(pausedAt !== undefined ? { pausedAt } : {})
  };
}

function sanitizeDevice(value: unknown): BrowserTabDevice | null {
  if (!isObject(value)) return null;
  if (
    typeof value['presetId'] !== 'string'
    || typeof value['width'] !== 'number' || !Number.isFinite(value['width']) || value['width'] <= 0
    || typeof value['height'] !== 'number' || !Number.isFinite(value['height']) || value['height'] <= 0
    || typeof value['dpr'] !== 'number' || !Number.isFinite(value['dpr']) || value['dpr'] <= 0
    || typeof value['mobile'] !== 'boolean'
    || typeof value['ua'] !== 'string'
    || typeof value['rotated'] !== 'boolean'
  ) return null;
  return {
    presetId: value['presetId'].slice(0, 128),
    width: value['width'],
    height: value['height'],
    dpr: value['dpr'],
    mobile: value['mobile'],
    ua: value['ua'].slice(0, 4_096),
    rotated: value['rotated']
  };
}

function sanitizeZoom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 5
    ? value
    : undefined;
}

function compactScope(state: BrowserSessionScopeState): BrowserSessionScopeState {
  if (JSON.stringify(state).length <= MAX_SCOPE_CHARS) return state;
  const compacted = compactHistory(state, 25, 2_048);
  if (JSON.stringify(compacted).length <= MAX_SCOPE_CHARS) return compacted;
  return compactHistory(compacted, 1, 2_048);
}

function compactHistory(
  state: BrowserSessionScopeState,
  historyLimit: number,
  urlLimit: number
): BrowserSessionScopeState {
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => {
      const start = Math.max(
        0,
        Math.min(tab.historyIndex - Math.floor(historyLimit / 2), tab.history.length - historyLimit)
      );
      const history = tab.history
        .slice(start, start + historyLimit)
        .map((url) => url.slice(0, urlLimit));
      return {
        ...tab,
        history,
        historyIndex: Math.max(0, Math.min(history.length - 1, tab.historyIndex - start))
      };
    })
  };
}

function validateScopeKey(value: unknown): string {
  if (typeof value !== 'string' || !isScopeKey(value)) {
    throw new Error('Browser Session State requires a valid Worktree scope key');
  }
  return value;
}

function isScopeKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SCOPE_KEY_CHARS;
}

function serializedScopesLength(scopes: Record<string, BrowserSessionScopeState>): number {
  return JSON.stringify(scopes).length;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
