export function encodeJson(value: unknown): Generator<Buffer>;
export class ReplayInterrupted extends Error {}
export function createEncryptedReplay(options?: {
  parentDirectory?: string;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  chunkBytes?: number;
}): Promise<{
  readonly directory: string;
  has(key: string): boolean;
  stats(): {
    entries: number;
    bytes: number;
    maxBytes: number;
    maxEntryBytes: number;
    chunkBytes: number;
  };
  capture(key: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<boolean>;
  verifyAll(): Promise<boolean>;
  replay(
    key: string,
    output: { prefix: Uint8Array; suffix: Uint8Array; write(chunk: Uint8Array): Promise<void> },
  ): Promise<boolean>;
  clear(): Promise<void>;
  close(): Promise<void>;
}>;
