import type { StorageArea } from '../../src/lib/storage.ts';

/** An in-memory `chrome.storage.local` that round-trips through JSON like the real one. */
export function memoryStorage(
  initial: Record<string, unknown> = {},
): StorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = structuredClone(data[key]);
      return Promise.resolve(out);
    },
    set(items) {
      for (const [k, v] of Object.entries(items))
        data[k] = JSON.parse(JSON.stringify(v)) as unknown;
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of keys) Reflect.deleteProperty(data, key);
      return Promise.resolve();
    },
  };
}
