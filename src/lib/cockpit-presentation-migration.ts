export const COCKPIT_PRESENTATION_ARCHIVE_KEY = 'soloe.cockpit.presentation.v1';

const DEFAULT_MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

export interface CockpitPresentationArchive {
  schemaVersion: 1;
  createdAt: string;
  catalogRevision: number;
  deviceIds: string[];
  projectMap: Record<string, string>;
  workspaceMap: Record<string, string>;
  entries: Array<{ key: string; value: string }>;
  checksum: string;
}

export interface CockpitPresentationMigrationInput {
  catalogRevision: number;
  deviceIds: string[];
  projectMap: Record<string, string>;
  workspaceMap: Record<string, string>;
  maxBytes?: number;
  now?: () => Date;
}

export function migrateCockpitPresentationState(
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>,
  input: CockpitPresentationMigrationInput
): { created: boolean; archive: CockpitPresentationArchive } {
  const existing = storage.getItem(COCKPIT_PRESENTATION_ARCHIVE_KEY);
  if (existing !== null) {
    return { created: false, archive: parseArchive(existing) };
  }
  const entries: CockpitPresentationArchive['entries'] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith('soloe.') || key === COCKPIT_PRESENTATION_ARCHIVE_KEY) continue;
    const value = storage.getItem(key);
    if (value !== null) entries.push({ key, value });
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  const archive: CockpitPresentationArchive = {
    schemaVersion: 1,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    catalogRevision: requiredRevision(input.catalogRevision),
    deviceIds: [...new Set(input.deviceIds)].sort(),
    projectMap: sortedRecord(input.projectMap),
    workspaceMap: sortedRecord(input.workspaceMap),
    entries,
    checksum: checksum(JSON.stringify(entries))
  };
  const serialized = JSON.stringify(archive);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Cockpit presentation archive byte limit is invalid.');
  }
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(
      `Cockpit presentation archive exceeds its ${maxBytes}-byte safety limit; legacy state was left untouched.`
    );
  }
  storage.setItem(COCKPIT_PRESENTATION_ARCHIVE_KEY, serialized);
  return { created: true, archive };
}

function parseArchive(source: string): CockpitPresentationArchive {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error('Cockpit presentation archive is corrupt.');
  const entries = value['entries'];
  if (
    value['schemaVersion'] !== 1
    || typeof value['createdAt'] !== 'string'
    || !Number.isFinite(Date.parse(value['createdAt']))
    || !Number.isSafeInteger(value['catalogRevision'])
    || !Array.isArray(value['deviceIds'])
    || !isRecord(value['projectMap'])
    || !isRecord(value['workspaceMap'])
    || !Array.isArray(entries)
    || typeof value['checksum'] !== 'string'
    || entries.some((entry) =>
      !isRecord(entry) || typeof entry['key'] !== 'string' || typeof entry['value'] !== 'string'
    )
    || checksum(JSON.stringify(entries)) !== value['checksum']
  ) {
    throw new Error('Cockpit presentation archive is corrupt.');
  }
  return structuredClone(value) as unknown as CockpitPresentationArchive;
}

function sortedRecord(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const mapped = value[key];
    if (typeof mapped !== 'string' || !mapped) throw new Error('Cockpit migration map is invalid.');
    result[key] = mapped;
  }
  return result;
}

function requiredRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Catalog revision is invalid.');
  return value;
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
