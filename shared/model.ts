import { z } from "zod";

export const ManagementSchema = z.object({
  includeBackground: z.boolean().default(false),
});
export type Management = z.infer<typeof ManagementSchema>;

export const RuntimeSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  provider: z.string(),
  workspace: z.string(),
  generation: z.string().nullable(),
  presence: z.enum(["running", "absent", "unknown"]),
  activity: z.enum(["idle", "working", "background", "unknown"]),
  memoryBytes: z.number().nonnegative().nullable(),
  releasable: z.boolean(),
  unavailableReason: z.string().nullable(),
  controlStatus: z.enum(["available", "after-restart", "unsupported", "unavailable"]).optional(),
});
export type Runtime = z.infer<typeof RuntimeSchema>;

export const ReleaseSchema = z.object({
  status: z.enum(["released", "absent", "busy", "generation-changed", "unsupported", "failed"]),
  error: z.string().nullable(),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const StopSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  generation: z.string(),
  dueAt: z.number(),
  state: z.enum(["scheduled", "deferred", "stopping", "failed"]),
  error: z.string().nullable(),
});
export type Stop = z.infer<typeof StopSchema>;

export const RowSchema = z.object({
  runtime: RuntimeSchema,
  ownerCount: z.number().int().positive(),
  hasSharedTabs: z.boolean().default(false),
  syncPending: z.boolean(),
  stopped: z.boolean(),
  stop: StopSchema.nullable(),
});
export type Row = z.infer<typeof RowSchema>;

export const InventorySchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  rows: z.array(RowSchema),
});
export type Inventory = z.infer<typeof InventorySchema>;

export interface RuntimeApi {
  supported(): boolean;
  snapshot(input: { agentIds: string[] }): Promise<Runtime[]>;
  releaseIfIdle(input: {
    agentId: string;
    expectedGeneration: string;
    requestId: string;
  }): Promise<Release>;
}

export interface LocalTabsState {
  status: "loading" | "ready";
  ownerId: string;
  revision: number;
  agentIds: readonly string[];
  sharedAgentIds?: readonly string[];
}
export interface LocalTabsApi {
  observe(listener: (state: LocalTabsState) => void): () => void;
}

// Optional capabilities are negotiated at the boundary; stock 0.11.2 stays usable.
export function runtimeApi(api: unknown): RuntimeApi | null {
  if (typeof api !== "object" || api === null || !("runtimes" in api)) return null;
  const runtime = api.runtimes;
  if (typeof runtime !== "object" || runtime === null) return null;
  if (!("supported" in runtime) || typeof runtime.supported !== "function") return null;
  if (!("snapshot" in runtime) || typeof runtime.snapshot !== "function") return null;
  if (!("releaseIfIdle" in runtime) || typeof runtime.releaseIfIdle !== "function") return null;
  const supported = runtime.supported.bind(runtime);
  const snapshot = runtime.snapshot.bind(runtime);
  const releaseIfIdle = runtime.releaseIfIdle.bind(runtime);
  return {
    supported: () => supported() === true,
    snapshot: async (input) => z.array(RuntimeSchema).parse(await snapshot(input)),
    releaseIfIdle: async (input) => ReleaseSchema.parse(await releaseIfIdle(input)),
  };
}

export const MIN_HOURS = 0.25;
export const MAX_HOURS = 168;
export const HoursSchema = z.number().finite().min(MIN_HOURS).max(MAX_HOURS);
