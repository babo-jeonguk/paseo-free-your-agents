import { createReplyCache } from "./proxy-cache.mjs";

// Pending metadata must never be evicted to invent an idle state. On overflow,
// retain the existing entries and permanently invalidate stop safety for this
// facade. Untracked messages still pass through with their original identities.
export function createProtocolTracker(options = {}) {
  const cache = createReplyCache({
    maxBytes: 256 * 1024,
    maxEntryBytes: 16 * 1024,
    maxKeyBytes: 1024,
    maxEntries: 256,
    ...options,
  });
  let valid = true;
  function key(id) {
    if (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) return null;
    if (typeof id === "string" && Buffer.byteLength(id) > 512) return null;
    return JSON.stringify([typeof id, id]);
  }
  return {
    set(id, value) {
      const encoded = key(id);
      if (
        encoded === null ||
        cache.has(encoded) ||
        !cache.set(encoded, value, { required: true })
      ) {
        valid = false;
        return false;
      }
      return true;
    },
    add(id) {
      const encoded = key(id);
      if (encoded !== null && cache.has(encoded)) return true;
      return this.set(id, null);
    },
    get(id) {
      const encoded = key(id);
      return encoded === null ? undefined : cache.get(encoded);
    },
    delete(id) {
      const encoded = key(id);
      if (encoded !== null) cache.delete(encoded);
    },
    get size() {
      return cache.stats().entries;
    },
    ids: () => cache.keys().map((key) => JSON.parse(key)[1]),
    valid: () => valid,
  };
}
