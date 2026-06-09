import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Node 25 ships a built-in `localStorage` / `sessionStorage` getter on
// globalThis that resolves to a broken stub (missing removeItem, etc.)
// when the runtime is started without a valid `--localstorage-file` path.
// jsdom provides a real Storage implementation but vitest's environment
// setup does not re-seat it on the jsdom `window` object in Node 25, so
// window.localStorage still hits the Node stub. Override both properties
// directly on `window` with a minimal in-memory Storage so that the
// beforeEach cleanup below works correctly.
function makeStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  } as Storage;
}

if (typeof window !== 'undefined' && typeof window.localStorage?.removeItem !== 'function') {
  Object.defineProperty(window, 'localStorage', { value: makeStorage(), writable: true });
}
if (typeof window !== 'undefined' && typeof window.sessionStorage?.removeItem !== 'function') {
  Object.defineProperty(window, 'sessionStorage', { value: makeStorage(), writable: true });
}

beforeEach(() => {
  window.sessionStorage.removeItem('ontoindex-llm-settings');
  window.localStorage.removeItem('ontoindex-llm-settings');
});
