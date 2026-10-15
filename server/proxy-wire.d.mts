import type { Readable, Writable } from "node:stream";
export function pumpJsonLines<T = unknown>(
  input: Readable,
  receive: (message: T, frame: Buffer) => Promise<void>,
): Promise<void>;
export function writeJsonLine(output: Writable, value: unknown): Promise<void>;
export function writeProtocolBytes(output: Writable, value: Uint8Array | string): Promise<void>;
export function createProtocolWriter(output: Writable): {
  send(value: unknown): Promise<void>;
  forward(frame: Uint8Array): Promise<void>;
  transaction<T>(
    work: (write: (chunk: Uint8Array | string) => Promise<void>) => Promise<T>,
  ): Promise<T>;
};
