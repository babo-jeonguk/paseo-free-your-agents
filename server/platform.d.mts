import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Stats } from "node:fs";

export const windows: boolean;
export const controlSupported: boolean;
export function ownerOnly(info: Pick<Stats, "uid" | "mode">, mode: number): boolean;
export function newControlPipe(): string;
export function isControlPipe(path: unknown): boolean;
export function linuxStart(pid: number): Promise<string | null | undefined>;
export function ownStart(): Promise<string | null | undefined>;
export function processExists(pid: number): boolean;
export function resolveWindowsCommand(
  command: string,
  env?: Record<string, string | undefined>,
): string;
export function nativeCommand(
  command: string,
  args: string[],
  env?: Record<string, string | undefined>,
): { file: string; args: string[]; options: SpawnOptions };
export function signalNative(child: ChildProcess, name: NodeJS.Signals): void;
