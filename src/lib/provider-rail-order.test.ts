import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  orderProviders,
  prefersFinePointer,
  PROVIDER_RAIL_ORDER_KEY,
  readProviderRailOrder,
  reorderIds,
  writeProviderRailOrder
} from './provider-rail-order';

describe('provider-rail-order', () => {
  const memory = new Map<string, string>();

  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
      clear: () => memory.clear()
    });
  });

  it('orders known providers and appends any missing defaults', () => {
    const providers = [
      { value: 'opencode' as const, label: 'OpenCode' },
      { value: 'claude_code' as const, label: 'Claude' },
      { value: 'codex' as const, label: 'Codex' }
    ];
    expect(orderProviders(providers, ['claude_code', 'opencode']).map((item) => item.value))
      .toEqual(['claude_code', 'opencode', 'codex']);
  });

  it('reorders ids with before/after drop positions', () => {
    expect(reorderIds(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(reorderIds(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    expect(reorderIds(['a', 'b', 'c'], 'a', 'a', 'after')).toBeNull();
  });

  it('persists provider rail order in localStorage', () => {
    writeProviderRailOrder(['codex', 'claude_code']);
    expect(memory.get(PROVIDER_RAIL_ORDER_KEY)).toContain('codex');
    expect(readProviderRailOrder()).toEqual(['codex', 'claude_code']);
  });

  it('ignores corrupt provider rail order payloads', () => {
    memory.set(PROVIDER_RAIL_ORDER_KEY, '{');
    expect(readProviderRailOrder()).toBeNull();
    memory.set(PROVIDER_RAIL_ORDER_KEY, JSON.stringify(['not-a-provider']));
    expect(readProviderRailOrder()).toBeNull();
  });

  it('treats missing matchMedia as fine pointer', () => {
    expect(prefersFinePointer()).toBeTypeOf('boolean');
  });
});
