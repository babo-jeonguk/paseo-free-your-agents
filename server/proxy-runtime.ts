import { constants } from "node:fs";
import {
  open,
  mkdir,
  readdir,
  readFile,
  lstat,
  unlink,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Runtime, RuntimeApi, Release } from "../shared/model";
import { assertPrivateDirectory, proxyRequest } from "./proxy-control";

const RecordSchema = z
  .object({
    version: z.literal(1),
    connectionId: z.string().uuid(),
    agentId: z.string().min(1).max(200),
    provider: z.enum(["codex", "claude"]),
    socketPath: z.string().min(1),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    proxyPid: z.number().int().positive().optional(),
    proxyStart: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
export type ProxyRecord = z.infer<typeof RecordSchema>;

const SnapshotSchema = z.object({
  controlVersion: z.literal(1),
  connectionId: z.string().uuid(),
  agentId: z.string(),
  phase: z.enum(["starting", "running", "stopping", "released"]),
  generation: z.string().uuid(),
  nativePid: z.number().int().positive().nullable(),
  activeTurns: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  pendingServerRequests: z.number().int().nonnegative(),
  unfinishedGoals: z.number().int().nonnegative(),
  backgroundTasks: z.number().int().nonnegative().default(0),
  sessionCrons: z.number().int().nonnegative().nullable().optional(),
  releaseSupported: z.boolean(),
  unavailableReason: z.string().max(500).optional(),
  nativeMemoryBytes: z.number().nonnegative().nullable().optional(),
  nativeMemoryKind: z.enum(["pss", "rss"]).optional(),
});
const OutcomeSchema = z.object({
  status: z.enum([
    "released",
    "absent",
    "busy",
    "generation-changed",
    "unsupported",
    "failed",
  ]),
  reason: z.string().optional(),
});
export interface ConversationMetadata {
  agentId: string;
  title: string;
  provider: string;
  workspace: string;
}

export type RuntimeProvider = "codex" | "claude";

export function createProxyRuntime(options: {
  directory: string;
  // Read-only metadata; callers must not use timeline/commands or ensure-load.
  metadata(agentIds: string[]): Promise<ConversationMetadata[]>;
  // The bridge provider that launches a conversation's provider, such as a
  // profile that extends Claude. Null when no bridge can launch it.
  runtimeProvider?(provider: string): Promise<RuntimeProvider | null>;
}) {
  const runtimeProvider =
    options.runtimeProvider ??
    (async (provider: string) =>
      provider === "codex" || provider === "claude" ? provider : null);
  const directory = resolve(options.directory);
  const recordsDirectory = join(directory, "connections");
  const recipesDirectory = join(directory, "recipes");
  let initialized: Promise<void> | null = null;
  function initialize() {
    if (!initialized)
      initialized = (async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await assertPrivateDirectory(directory);
        for (const child of [recordsDirectory, recipesDirectory]) {
          await mkdir(child, { mode: 0o700 }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            },
          );
          await assertPrivateDirectory(child);
        }
      })().catch((error) => {
        initialized = null;
        throw error;
      });
    return initialized;
  }
  async function readRecords(): Promise<ProxyRecord[]> {
    await initialize();
    const records: ProxyRecord[] = [];
    for (const name of await readdir(recordsDirectory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      // NOFOLLOW plus fstat avoids following a replaced/symlinked record.
      const file = await open(
        join(recordsDirectory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!file) continue; // A gracefully closed proxy can remove its own record.
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 8192
        ) {
          throw new Error(
            "Runtime Control connection record is not private or valid.",
          );
        }
        const contents = await file.readFile("utf8");
        const record = RecordSchema.parse(JSON.parse(contents));
        if (name !== record.connectionId + ".json")
          throw new Error("Runtime Control connection identity is invalid.");
        if (record.proxyPid && record.proxyStart) {
          const owner = await readFile(
            `/proc/${record.proxyPid}/stat`,
            "utf8",
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          const born = owner
            ?.slice(owner.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/)[19];
          if (owner === null || (born && born !== record.proxyStart)) {
            const path = join(recordsDirectory, name),
              current = await lstat(path).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return null;
                  throw error;
                },
              );
            if (current) {
              if (
                current.ino !== info.ino ||
                current.dev !== info.dev ||
                current.size !== info.size
              )
                throw new Error(
                  "Connection record changed during reconciliation",
                );
              // Re-read the owned fd by position before deleting a dead record.
              // This metadata is never used to select a PID for termination.
              const buffer = Buffer.alloc(info.size);
              const read = await file.read(buffer, 0, buffer.length, 0);
              if (
                read.bytesRead !== info.size ||
                buffer.toString("utf8") !== contents
              )
                throw new Error(
                  "Connection record changed during reconciliation",
                );
              await unlink(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
            continue;
          }
        }
        records.push(record);
      } finally {
        await file.close();
      }
    }
    return records;
  }
  async function inspect(record: ProxyRecord) {
    const view = SnapshotSchema.parse(
      await proxyRequest(record, { id: randomUUID(), op: "snapshot" }),
    );
    if (
      view.connectionId !== record.connectionId ||
      view.agentId !== record.agentId
    ) {
      throw new Error(
        "Runtime Control endpoint belongs to a different conversation.",
      );
    }
    if ((view.phase === "released") !== (view.nativePid === null)) {
      // A starting process can temporarily lack a PID; report unknown until it
      // establishes one, rather than claiming it has stopped.
      throw new Error("Runtime Control process state is not yet confirmed.");
    }
    return view;
  }
  const generation = (record: ProxyRecord, native: string) =>
    record.connectionId + ":" + native;
  function unknown(
    metadata: ConversationMetadata,
    reason: string,
    controlStatus: Runtime["controlStatus"] = "unavailable",
  ): Runtime {
    return {
      ...metadata,
      generation: null,
      presence: "unknown",
      activity: "unknown",
      memoryBytes: null,
      releasable: false,
      unavailableReason: reason,
      controlStatus,
    };
  }
  const api: RuntimeApi = {
    supported: () => process.platform === "linux",
    async snapshot({ agentIds }) {
      const [records, metadata] = await Promise.all([
        readRecords(),
        options.metadata(agentIds),
      ]);
      const details = new Map(metadata.map((value) => [value.agentId, value]));
      const bridges = new Map<string, Promise<RuntimeProvider | null>>();
      const bridgeFor = (provider: string) => {
        let bridge = bridges.get(provider);
        if (!bridge) {
          bridge = runtimeProvider(provider).catch(() => null);
          bridges.set(provider, bridge);
        }
        return bridge;
      };
      return Promise.all(
        [...new Set(agentIds)].map(async (agentId) => {
          const info = details.get(agentId) ?? {
            agentId,
            title: "Conversation",
            provider: "Unknown",
            workspace: "",
          };
          const bridge = await bridgeFor(info.provider);
          const matches = records.filter(
            (record) => record.agentId === agentId,
          );
          if (!matches.length)
            return bridge === "codex"
              ? unknown(
                  info,
                  "Controls become available after the Paseo daemon restarts.",
                  "after-restart",
                )
              : bridge === "claude"
                ? unknown(
                    info,
                    "A managed Claude runtime connection has not yet been established.",
                  )
                : unknown(
                    info,
                    "Process control is not available for this provider yet.",
                    "unsupported",
                  );
          // Multiple or unreachable owners are never resolved by picking a PID or
          // the newest timestamp. Preserve uncertainty and all existing work.
          if (matches.length !== 1)
            return unknown(
              info,
              "Multiple runtime connections need reconciliation.",
            );
          const record = matches[0]!;
          try {
            if (bridge !== record.provider)
              throw new Error("Provider mismatch");
            const view = await inspect(record);
            const absent = view.phase === "released";
            const working =
              view.activeTurns +
                view.pendingRequests +
                view.pendingServerRequests >
              0;
            return {
              ...info,
              generation: absent ? null : generation(record, view.generation),
              presence: absent ? "absent" : "running",
              activity: absent
                ? "idle"
                : working
                  ? "working"
                  : view.unfinishedGoals +
                      view.backgroundTasks +
                      (view.sessionCrons ?? 0)
                    ? "background"
                    : view.phase === "running"
                      ? "idle"
                      : "unknown",
              memoryBytes: absent ? 0 : (view.nativeMemoryBytes ?? null),
              releasable:
                !absent && view.releaseSupported && view.phase === "running",
              unavailableReason: view.releaseSupported
                ? null
                : (view.unavailableReason ??
                  "This provider's process control is not yet available."),
              controlStatus: view.releaseSupported
                ? "available"
                : "unsupported",
            } satisfies Runtime;
          } catch {
            return unknown(
              info,
              "The runtime connection is unavailable. No process will be stopped.",
            );
          }
        }),
      );
    },
    async releaseIfIdle({
      agentId,
      expectedGeneration,
      requestId,
    }): Promise<Release> {
      const records = (await readRecords()).filter(
        (record) => record.agentId === agentId,
      );
      if (records.length !== 1)
        return {
          status: "unsupported",
          error: "Runtime ownership is not confirmed.",
        };
      const record = records[0]!;
      const prefix = record.connectionId + ":";
      if (!expectedGeneration.startsWith(prefix))
        return { status: "generation-changed", error: null };
      const nativeGeneration = expectedGeneration.slice(prefix.length);
      if (!z.string().uuid().safeParse(nativeGeneration).success)
        return { status: "generation-changed", error: null };
      // Authenticate identity first. A transport timeout below is intentionally
      // thrown: the scheduler must reconcile, not assume the stop was canceled.
      await inspect(record);
      const result = OutcomeSchema.parse(
        await proxyRequest(record, {
          id: requestId,
          op: "release",
          expectedGeneration: nativeGeneration,
        }),
      );
      return { status: result.status, error: result.reason ?? null };
    },
  };
  return {
    api,
    hasConnections: async () => (await readRecords()).length > 0,
    async prepareSession(input: {
      agentId: string;
      provider: string;
      purpose: "interactive" | "history";
    }): Promise<Record<string, string>> {
      if (
        !api.supported() ||
        !["codex", "claude"].includes(input.provider) ||
        input.purpose !== "interactive"
      )
        return {};
      await initialize();
      z.string().min(1).max(200).parse(input.agentId);
      // Every launch claims its own identity, so one recipe per conversation is
      // enough. A fresh recipe per session open would accumulate forever.
      const recipeId = createHash("sha256")
        .update(input.provider + "\0" + input.agentId)
        .digest("hex")
        .slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      const path = join(recipesDirectory, recipeId + ".json");
      // The launch closure may outlive a proxy. It receives a recipe, not a
      // single-use endpoint. Replace atomically so a concurrent launch reads
      // either complete version.
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(
            JSON.stringify({
              version: 1,
              recipeId,
              agentId: input.agentId,
              provider: input.provider,
              recordsDirectory,
            }) + "\n",
          );
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return { RUNTIME_PROXY_RECIPE_FILE: path };
    },
    // Reloading/disabling the controller must never terminate a provider. The
    // stable records are intentionally left for the next controller instance.
  };
}
