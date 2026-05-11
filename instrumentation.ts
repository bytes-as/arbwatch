// Node.js 25 introduced `localStorage` as a global, but without a
// `--localstorage-file` argument it's a broken stub where `getItem` is
// undefined.  Next.js 15 dev overlay code calls `localStorage.getItem` during
// server-side rendering, causing a 500.  This polyfill replaces the broken
// global with a no-op in-memory implementation so the dev server works on
// Node 25.  It has no effect in production (localStorage is never a global
// there) and no effect on browsers (they have a real implementation).
export async function register() {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem !== "function") {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => { store.clear(); },
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      configurable: true,
      writable: true,
    });
  }
}
