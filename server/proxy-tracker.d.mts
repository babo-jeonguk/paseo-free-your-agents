export function createProtocolTracker<T = unknown>(options?: {
  maxBytes?: number;
  maxEntryBytes?: number;
  maxKeyBytes?: number;
  maxEntries?: number;
}): {
  set(id: unknown, value: T): boolean;
  add(id: unknown): boolean;
  get(id: unknown): T | undefined;
  delete(id: unknown): void;
  readonly size: number;
  ids(): (string | number)[];
  valid(): boolean;
};
