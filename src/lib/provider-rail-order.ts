import {
  isAgentProvider,
  type AgentRuntimeProvider
} from '@shared/types/sessions.js';

export const PROVIDER_RAIL_ORDER_KEY = 'soloe.provider-rail-order';

export type DropPosition = 'before' | 'after';

export function orderProviders<T extends { value: AgentRuntimeProvider }>(
  providers: readonly T[],
  savedOrder: readonly AgentRuntimeProvider[] | null
): T[] {
  if (!savedOrder || savedOrder.length === 0) return [...providers];
  const byValue = new Map(providers.map((provider) => [provider.value, provider]));
  const ordered: T[] = [];
  for (const value of savedOrder) {
    const provider = byValue.get(value);
    if (!provider) continue;
    ordered.push(provider);
    byValue.delete(value);
  }
  for (const provider of providers) {
    if (byValue.has(provider.value)) ordered.push(provider);
  }
  return ordered;
}

export function readProviderRailOrder(): AgentRuntimeProvider[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PROVIDER_RAIL_ORDER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const order = parsed.filter(isAgentProvider);
    return order.length > 0 ? order : null;
  } catch {
    return null;
  }
}

export function writeProviderRailOrder(order: readonly AgentRuntimeProvider[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PROVIDER_RAIL_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Quota / private mode — order still applies for this session via state.
  }
}

export function reorderIds<T extends string>(
  ids: readonly T[],
  draggedId: T,
  targetId: T,
  position: DropPosition
): T[] | null {
  if (draggedId === targetId) return null;
  if (!ids.includes(draggedId) || !ids.includes(targetId)) return null;
  const without = ids.filter((id) => id !== draggedId);
  let insertAt = without.indexOf(targetId);
  if (insertAt < 0) insertAt = without.length;
  if (position === 'after') insertAt += 1;
  const next = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
  if (next.length === ids.length && next.every((id, index) => id === ids[index])) return null;
  return next;
}

export function verticalDropPosition(event: DragEvent, el: HTMLElement): DropPosition {
  const rect = el.getBoundingClientRect();
  return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
}

export function horizontalDropPosition(event: DragEvent, el: HTMLElement): DropPosition {
  const rect = el.getBoundingClientRect();
  return event.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
}

export function prefersFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(pointer: fine)').matches;
}
