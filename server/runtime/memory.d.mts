export function createMemorySampler(
  io?: {
    readFile(path: string, encoding: string): Promise<string>;
    readdir(path: string): Promise<string[]>;
  },
  platformWindows?: boolean,
): (
  pid?: number,
) => Promise<{ nativeMemoryBytes: number | null; nativeMemoryKind?: string }>;
export function createMemoryReclaimer(options?: {
  gc?: (options: { type: string; execution: string; flavor: string }) => void;
  quietMs?: number;
  minBytes?: number;
}): {
  note(frame: string | Uint8Array): void;
  released(isReleased: () => boolean): void;
};
