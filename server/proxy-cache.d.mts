export function createReplyCache(options?: {
  maxBytes?: number;
  maxEntryBytes?: number;
  maxKeyBytes?: number;
  maxEntries?: number;
}): {
  set(key: string, value: unknown, options?: { required?: boolean }): boolean;
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
  clear(): void;
  unpin(): void;
  stats(): { entries: number; bytes: number; maxBytes: number; maxEntryBytes: number };
};
