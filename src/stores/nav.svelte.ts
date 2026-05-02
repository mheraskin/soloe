import type { Session } from '@shared/types/sessions.js';
import { sessions } from './sessions.svelte';
import { projects } from './projects.svelte';
import { confirmStore } from './confirm.svelte';
import { reportError } from './toast.svelte';

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

class NavStore {
  flat = $derived.by<Session[]>(() => {
    const grouped = sessions.byProject;
    const present = new Set(sessions.projectIds);
    const projectOrder: string[] = [];
    for (const p of projects.recents) {
      if (present.has(p.id)) projectOrder.push(p.id);
    }
    for (const id of sessions.projectIds) {
      if (!projectOrder.includes(id)) projectOrder.push(id);
    }

    const out: Session[] = [...sessions.standalone];
    for (const projectKey of projectOrder) {
      const list = grouped[projectKey] ?? [];
      const cwdOrder: string[] = [];
      const buckets: Record<string, Session[]> = {};
      for (const s of list) {
        const k = normPath(s.cwd);
        if (!buckets[k]) {
          buckets[k] = [];
          cwdOrder.push(k);
        }
        buckets[k].push(s);
      }
      for (const k of cwdOrder) {
        for (const s of buckets[k]!) out.push(s);
      }
    }
    return out;
  });

  activeIndex = $derived.by<number>(() => {
    const id = sessions.selectedId;
    if (!id) return -1;
    return this.flat.findIndex((s) => s.id === id);
  });

  selectByIndex(n: number): void {
    const list = this.flat;
    const target = list[n];
    if (target) sessions.select(target.id);
  }

  cycleNext(): void {
    const list = this.flat;
    if (list.length === 0) return;
    const idx = this.activeIndex;
    const next = idx < 0 ? 0 : (idx + 1) % list.length;
    sessions.select(list[next]!.id);
  }

  cyclePrev(): void {
    const list = this.flat;
    if (list.length === 0) return;
    const idx = this.activeIndex;
    const next = idx <= 0 ? list.length - 1 : idx - 1;
    sessions.select(list[next]!.id);
  }

  async closeActive(): Promise<void> {
    const id = sessions.selectedId;
    if (!id) return;
    const session = sessions.sessions.find((s) => s.id === id);
    if (!session) return;
    const ok = await confirmStore.ask({
      title: 'Delete session',
      message: `Delete session "${session.name || '(unnamed)'}"?`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await sessions.remove(id);
    } catch (err) {
      reportError(err);
    }
  }
}

export const nav = new NavStore();
