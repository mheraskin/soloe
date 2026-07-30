const localStorageGetter = Object
  .getOwnPropertyDescriptor(globalThis, 'localStorage')
  ?.get?.toString();
const hasNodeLazyStorage =
  localStorageGetter?.includes('mod ??= require(id)') ?? false;

if (typeof window !== 'undefined' && hasNodeLazyStorage) {
  const entriesByStorage = new WeakMap<Storage, Map<string, string>>();
  const entriesFor = (storage: Storage): Map<string, string> => {
    const existing = entriesByStorage.get(storage);
    if (existing) return existing;
    const entries = new Map<string, string>();
    entriesByStorage.set(storage, entries);
    return entries;
  };

  Object.defineProperties(Storage.prototype, {
    length: {
      configurable: true,
      get(this: Storage): number {
        return entriesFor(this).size;
      }
    },
    clear: {
      configurable: true,
      writable: true,
      value(this: Storage): void {
        entriesFor(this).clear();
      }
    },
    getItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string): string | null {
        return entriesFor(this).get(String(key)) ?? null;
      }
    },
    key: {
      configurable: true,
      writable: true,
      value(this: Storage, index: number): string | null {
        return [...entriesFor(this).keys()][index] ?? null;
      }
    },
    removeItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string): void {
        entriesFor(this).delete(String(key));
      }
    },
    setItem: {
      configurable: true,
      writable: true,
      value(this: Storage, key: string, value: string): void {
        entriesFor(this).set(String(key), String(value));
      }
    }
  });

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: Object.create(Storage.prototype) as Storage
  });
}
