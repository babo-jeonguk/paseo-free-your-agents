export function createMemorySampler(
  io?: {
    readFile(path: string, encoding: string): Promise<string>;
    readdir(path: string): Promise<string[]>;
  },
  platformWindows?: boolean,
): (
  pid?: number,
) => Promise<{ nativeMemoryBytes: number | null; nativeMemoryKind?: string }>;
export function reclaimReleasedMemory(isReleased: () => boolean): void;
