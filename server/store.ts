import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ManagementSchema, StopSchema } from "../shared/model";

export const OwnerSchema = z.object({
  id: z.string(),
  epoch: z.string(),
  revision: z.number().int(),
  agentIds: z.array(z.string()),
  sharedAgentIds: z.array(z.string()).default([]),
  seenAt: z.number(),
});
export const StateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  management: ManagementSchema.default({ includeBackground: false }),
  owners: z.array(OwnerSchema),
  stops: z.array(StopSchema),
  stoppedIds: z.array(z.string()),
});
export type State = z.infer<typeof StateSchema>;
export interface StateStore {
  read(): Promise<State>;
  write(state: State): Promise<void>;
}

export function emptyState(): State {
  return { version: 1, revision: 0, management: { includeBackground: false }, owners: [], stops: [], stoppedIds: [] };
}

export function createFileStore(
  path = join(
    process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "plugin-data",
    "free-your-agents",
    "state.json",
  ),
): StateStore {
  return {
    async read() {
      try {
        return StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return emptyState();
        // Invalid policy data must never silently become a new automatic-stop policy.
        throw error;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
