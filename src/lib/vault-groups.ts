import type { VaultEntry } from '@shared/types/vault.js';

export interface ScopedVaultEntry {
  entry: VaultEntry;
  vaultCwd: string;
}

export interface CredentialOriginGroup {
  origin: string;
  label: string;
  entries: ScopedVaultEntry[];
}

export function groupCredentialsByOrigin(
  entries: ScopedVaultEntry[]
): CredentialOriginGroup[] {
  const groups = new Map<string, ScopedVaultEntry[]>();
  for (const item of entries) {
    const current = groups.get(item.entry.origin) ?? [];
    current.push(item);
    groups.set(item.entry.origin, current);
  }
  return Array.from(groups, ([origin, scopedEntries]) => ({
    origin,
    label: originLabel(origin),
    entries: scopedEntries.sort((a, b) =>
      a.entry.username.localeCompare(b.entry.username)
    )
  })).sort((a, b) => a.label.localeCompare(b.label));
}

export function filterCredentialGroups(
  groups: CredentialOriginGroup[],
  query: string
): CredentialOriginGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  const out: CredentialOriginGroup[] = [];
  for (const group of groups) {
    if (
      group.origin.toLocaleLowerCase().includes(needle)
      || group.label.toLocaleLowerCase().includes(needle)
    ) {
      out.push(group);
      continue;
    }
    const entries = group.entries.filter(({ entry }) =>
      entry.username.toLocaleLowerCase().includes(needle)
      || entry.label?.toLocaleLowerCase().includes(needle)
    );
    if (entries.length > 0) out.push({ ...group, entries });
  }
  return out;
}

export function originLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
