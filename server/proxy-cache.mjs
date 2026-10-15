// Serialized reply cache shared by the provider compatibility adapters. Limits
// cover retained UTF-8 bytes (keys included), not transient JSON parsing or the
// JS engine's allocation overhead. No transcript is written to disk.
export function createReplyCache({
  maxBytes = 16 * 1024 * 1024,
  maxEntryBytes = 8 * 1024 * 1024,
  maxKeyBytes = 4096,
  maxEntries = 128,
} = {}) {
  for (const value of [maxBytes, maxEntryBytes, maxKeyBytes, maxEntries])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid reply cache limit");
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(key);
  }
  return {
    set(key, value, { required = false } = {}) {
      // Invalidate a previous successful response even when its replacement
      // cannot fit. Serving stale history after a failed capture is unsafe.
      remove(key);
      if (typeof key !== "string" || Buffer.byteLength(key) > maxKeyBytes) return false;
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return false;
      const size = Buffer.byteLength(key) + Buffer.byteLength(serialized);
      if (size > maxEntryBytes || size > maxBytes) return false;
      const evictable = [...entries].filter(([, entry]) => !entry.required);
      const available =
        maxBytes - bytes + evictable.reduce((sum, [, entry]) => sum + entry.bytes, 0);
      const availableSlots = maxEntries - entries.size + evictable.length;
      if (available < size || availableSlots < 1) return false;
      for (const [candidate] of evictable) {
        if (bytes + size <= maxBytes && entries.size < maxEntries) break;
        remove(candidate);
      }
      entries.set(key, { serialized, bytes: size, required });
      bytes += size;
      return true;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Keep an LRU order, but never evict a required replay while stopped.
      entries.delete(key);
      entries.set(key, entry);
      return JSON.parse(entry.serialized);
    },
    has: (key) => entries.has(key),
    delete: remove,
    keys: () => [...entries.keys()],
    clear() {
      entries.clear();
      bytes = 0;
    },
    // A new running-generation capture may replace the previous stop's pinned
    // histories. Call only while native is present; never unpin during release.
    unpin() {
      for (const entry of entries.values()) entry.required = false;
    },
    stats: () => ({ entries: entries.size, bytes, maxBytes, maxEntryBytes }),
  };
}
