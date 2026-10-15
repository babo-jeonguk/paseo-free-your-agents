import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { changeStopRpc, publishTabsRpc } from "../shared/rpc";
import type {
  Inventory,
  Row,
  Runtime,
  RuntimeApi,
  Stop,
} from "../shared/model";
import { HoursSchema } from "../shared/model";
import type { State, StateStore } from "./store";

type TabReport = z.input<typeof publishTabsRpc.input>;
type StopChange = z.output<typeof changeStopRpc.input>;
const FRESH_MS = 45_000;

export function createControl(store: StateStore, now: () => number = Date.now) {
  let state: State | null = null;
  let api: RuntimeApi | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const confirmedOwners = new Set<string>();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  }
  async function current(): Promise<State> {
    if (state === null) state = await store.read();
    return state;
  }
  async function save(next: State): Promise<void> {
    next.revision = (state?.revision ?? next.revision) + 1;
    await store.write(next);
    state = next;
  }
  function membership(value: State) {
    const rows = new Map<
      string,
      { ownerCount: number; syncPending: boolean; hasSharedTabs: boolean }
    >();
    for (const owner of value.owners) {
      const stale =
        !confirmedOwners.has(owner.id) || now() - owner.seenAt > FRESH_MS;
      for (const id of owner.agentIds) {
        const row = rows.get(id) ?? {
          ownerCount: 0,
          syncPending: false,
          hasSharedTabs: false,
        };
        row.ownerCount += 1;
        row.syncPending ||= stale;
        row.hasSharedTabs ||= owner.sharedAgentIds.includes(id);
        rows.set(id, row);
      }
    }
    return rows;
  }
  function missing(id: string): Runtime {
    return {
      agentId: id,
      title: "Conversation",
      provider: "Unknown",
      workspace: "",
      generation: null,
      presence: "unknown",
      activity: "unknown",
      memoryBytes: null,
      releasable: false,
      unavailableReason: "Runtime status is unavailable.",
    };
  }
  async function snapshots(
    value: State,
    onlyIds?: Iterable<string>,
  ): Promise<Map<string, Runtime>> {
    if (!api || !api.supported()) return new Map();
    const ids = new Set(onlyIds ?? membership(value).keys());
    if (!onlyIds) for (const stop of value.stops) ids.add(stop.agentId);
    if (ids.size === 0) return new Map();
    const entries = await api.snapshot({ agentIds: [...ids] });
    return new Map(entries.map((runtime) => [runtime.agentId, runtime]));
  }
  async function tickInternal(): Promise<void> {
    if (!api || !api.supported()) return;
    const value = structuredClone(await current());
    if (value.stops.length === 0 && value.stoppedIds.length === 0) return;
    const runtimes = await snapshots(
      value,
      new Set([
        ...value.stops.map((stop) => stop.agentId),
        ...value.stoppedIds,
      ]),
    );
    const open = membership(value);
    let changed = false;
    for (const stop of [...value.stops]) {
      const runtime = runtimes.get(stop.agentId);
      const obsolete =
        !open.has(stop.agentId) ||
        (runtime?.presence === "absent" && stop.state !== "failed") ||
        (runtime?.generation !== null &&
          runtime?.generation !== undefined &&
          runtime.generation !== stop.generation);
      if (obsolete) {
        value.stops = value.stops.filter((entry) => entry.id !== stop.id);
        changed = true;
        continue;
      }
      if (stop.dueAt > now() || stop.state === "failed") continue;
      if (!runtime || runtime.presence === "unknown") {
        const reconciling = stop.state === "stopping";
        stop.state = reconciling ? "stopping" : "deferred";
        stop.error = reconciling
          ? "The previous stop result is not confirmed. Waiting for runtime status."
          : "Runtime status is unavailable. The stop is deferred.";
        changed = true;
        continue;
      }
      stop.state = "stopping";
      stop.error = null;
      // Cancellation and new policies wait for this lane. A cancelled policy is never
      // acknowledged while an old release request can still reach the host.
      await save(structuredClone(value));
      let result;
      try {
        result = await api.releaseIfIdle({
          agentId: stop.agentId,
          expectedGeneration: stop.generation,
          requestId: stop.id,
        });
      } catch (error) {
        // A transport timeout does not revoke a request already admitted by the daemon.
        // Keep its operation ID and reconcile before accepting a replacement or cancellation.
        stop.state = "stopping";
        stop.error = `The stop result is not confirmed. Reconnect to reconcile. ${
          error instanceof Error ? error.message : String(error)
        }`;
        changed = true;
        continue;
      }
      if (
        result.status === "released" ||
        result.status === "absent" ||
        result.status === "generation-changed"
      ) {
        value.stops = value.stops.filter((entry) => entry.id !== stop.id);
        if (result.status === "released") {
          value.stoppedIds = [...new Set([...value.stoppedIds, stop.agentId])];
          runtimes.set(stop.agentId, {
            ...runtime,
            presence: "absent",
            generation: null,
          });
        }
      } else {
        stop.state = result.status === "busy" ? "deferred" : "failed";
        stop.error = result.error;
      }
      changed = true;
    }
    const previouslyStopped = value.stoppedIds;
    value.stoppedIds = previouslyStopped.filter(
      (id) => open.has(id) && runtimes.get(id)?.presence !== "running",
    );
    changed ||= value.stoppedIds.length !== previouslyStopped.length;
    if (changed) await save(value);
  }
  return {
    attach(runtime: RuntimeApi | null) {
      api = runtime;
    },
    register(ownerId: string) {
      return serialize(async () => {
        const value = structuredClone(await current());
        const previous = value.owners.find((owner) => owner.id === ownerId);
        const epoch = randomUUID();
        value.owners = value.owners.filter((owner) => owner.id !== ownerId);
        value.owners.push({
          id: ownerId,
          epoch,
          revision: -1,
          agentIds: previous?.agentIds ?? [],
          sharedAgentIds: previous?.sharedAgentIds ?? [],
          seenAt: previous?.seenAt ?? 0,
        });
        confirmedOwners.delete(ownerId);
        await save(value);
        return epoch;
      });
    },
    publish(report: TabReport) {
      return serialize(async () => {
        const value = structuredClone(await current());
        const owner = value.owners.find((entry) => entry.id === report.ownerId);
        if (
          !owner ||
          owner.epoch !== report.epoch ||
          report.revision < owner.revision
        )
          return false;
        // Retries may refresh freshness, but a revision cannot change its tab set.
        const ids = [...new Set(report.agentIds)].sort();
        const sharedIds = [...new Set(report.sharedAgentIds ?? [])]
          .filter((id) => ids.includes(id))
          .sort();
        if (
          report.revision === owner.revision &&
          (JSON.stringify(ids) !== JSON.stringify(owner.agentIds) ||
            JSON.stringify(sharedIds) !== JSON.stringify(owner.sharedAgentIds))
        )
          return false;
        owner.revision = report.revision;
        owner.agentIds = ids;
        owner.sharedAgentIds = sharedIds;
        owner.seenAt = now();
        const open = membership(value);
        value.stops = value.stops.filter((stop) => open.has(stop.agentId));
        await save(value);
        confirmedOwners.add(owner.id);
        return true;
      });
    },
    list(): Promise<Inventory> {
      return serialize(async () => {
        const value = await current();
        const supported = api !== null && api.supported();
        const runtimes = await snapshots(value);
        const rows: Row[] = [];
        for (const [id, presence] of membership(value)) {
          const runtime = runtimes.get(id) ?? missing(id);
          rows.push({
            runtime,
            ...presence,
            stopped:
              runtime.presence === "absent" && value.stoppedIds.includes(id),
            stop: value.stops.find((stop) => stop.agentId === id) ?? null,
          });
        }
        return {
          supported,
          reason: supported
            ? null
            : "Process control is unavailable on this host. Compatibility controls currently require Linux.",
          revision: value.revision,
          rows,
        };
      });
    },
    change(input: StopChange) {
      return serialize(async () => {
        const value = structuredClone(await current());
        const previous = value.stops.find(
          (stop) => stop.agentId === input.agentId,
        );
        if ((previous?.id ?? null) !== input.expectedStopId)
          return {
            changed: false,
            reason: "This stop already ran or changed. Refresh and try again.",
          };
        if (previous?.state === "stopping")
          return {
            changed: false,
            reason:
              "A stop request is already in progress. Wait for its result before changing the policy.",
          };
        if (input.action === "cancel") {
          value.stops = value.stops.filter(
            (stop) => stop.agentId !== input.agentId,
          );
          await save(value);
          return { changed: true, reason: null };
        }
        if (!membership(value).has(input.agentId))
          return {
            changed: false,
            reason: "This conversation has no open tabs.",
          };
        const runtime = (await snapshots(value, [input.agentId])).get(
          input.agentId,
        );
        if (
          !runtime ||
          !runtime.releasable ||
          runtime.presence !== "running" ||
          runtime.generation === null
        )
          return {
            changed: false,
            reason:
              runtime?.unavailableReason ??
              "The process cannot be stopped on this host.",
          };
        if (runtime.generation !== input.expectedGeneration)
          return {
            changed: false,
            reason: "The process changed. Refresh and try again.",
          };
        let delay = 0;
        if (input.action === "schedule")
          delay = HoursSchema.parse(input.hours) * 3_600_000;
        const stop: Stop = {
          id: randomUUID(),
          agentId: input.agentId,
          generation: runtime.generation,
          dueAt: now() + delay,
          state: "scheduled",
          error: null,
        };
        value.stops = value.stops.filter(
          (entry) => entry.agentId !== input.agentId,
        );
        value.stops.push(stop);
        await save(value);
        if (input.action === "now") await tickInternal();
        return { changed: true, reason: null };
      });
    },
    tick: () => serialize(tickInternal),
    drain: () => tail,
  };
}
