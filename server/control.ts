import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { changeStopRpc, publishTabsRpc } from "../shared/rpc";
import type {
  Inventory,
  Management,
  Row,
  Runtime,
  RuntimeApi,
  Stop,
} from "../shared/model";
import { HoursSchema } from "../shared/model";
import type { State, StateStore } from "./store";
import { createOwnerLeaseRegistry } from "./owner-leases";

type TabReport = z.input<typeof publishTabsRpc.input>;
type StopChange = z.output<typeof changeStopRpc.input>;

export function createControl(store: StateStore, now: () => number = Date.now) {
  let state: State | null = null;
  let api: RuntimeApi | null = null;
  let selectForeground: (ids: string[]) => Promise<string[]> = async (ids) => ids;
  let tail: Promise<unknown> = Promise.resolve();
  const leases = createOwnerLeaseRegistry(now);

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
  async function reconcileOwners() {
    const result = leases.reconcile(await current());
    if (result.dirty) await save(result.state);
    return result.state;
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
  async function managedMembership(value: State) {
    const open = leases.membership(value);
    if (value.management.includeBackground || open.size === 0) return open;
    const foreground = new Set(await selectForeground([...open.keys()]));
    return new Map([...open].filter(([id]) => foreground.has(id)));
  }
  async function snapshots(
    open: Awaited<ReturnType<typeof managedMembership>>,
    onlyIds?: Iterable<string>,
  ): Promise<Map<string, Runtime>> {
    if (!api || !api.supported()) return new Map();
    const ids = new Set([...(onlyIds ?? open.keys())].filter((id) => open.has(id)));
    if (ids.size === 0) return new Map();
    const entries = await api.snapshot({ agentIds: [...ids] });
    return new Map(entries.map((runtime) => [runtime.agentId, runtime]));
  }
  async function tickInternal(): Promise<void> {
    const reconciled = await reconcileOwners();
    if (!api || !api.supported()) return;
    // Only pending stops need runtime status, so a host without one polls
    // nothing. list() reconciles stopped rows, as it reads every row's status.
    if (reconciled.stops.length === 0) return;
    const value = structuredClone(reconciled);
    const open = await managedMembership(value);
    const runtimes = await snapshots(
      open,
      new Set(
        value.stops
          .filter((stop) => open.get(stop.agentId)?.confirmed)
          .map((stop) => stop.agentId),
      ),
    );
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
      if (!open.get(stop.agentId)?.confirmed) {
        if (stop.dueAt <= now() && !["failed", "stopping"].includes(stop.state)) {
          stop.state = "deferred";
          stop.error = "Open tabs are waiting to resynchronize. The stop is deferred.";
          changed = true;
        }
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
    value.stoppedIds = stillStopped(value, runtimes, open);
    changed ||= value.stoppedIds.length !== previouslyStopped.length;
    if (changed) await save(value);
  }
  // A stopped conversation that runs again, or whose tabs closed, is no longer
  // stopped. A conversation without status keeps its label.
  function stillStopped(
    value: State,
    runtimes: Map<string, Runtime>,
    open = leases.membership(value),
  ) {
    return value.stoppedIds.filter(
      (id) => open.has(id) && runtimes.get(id)?.presence !== "running",
    );
  }
  return {
    attach(runtime: RuntimeApi | null, foreground?: (ids: string[]) => Promise<string[]>) {
      api = runtime;
      if (foreground) selectForeground = foreground;
    },
    management() {
      return serialize(async () => ({ ...(await current()).management }));
    },
    changeManagement(input: Management) {
      return serialize(async () => {
        const value = structuredClone(await reconcileOwners());
        value.management = { ...input };
        const open = await managedMembership(value);
        const excluded = value.stops.filter((stop) => !open.has(stop.agentId));
        if (excluded.some((stop) => stop.state === "stopping"))
          throw new Error("A stop result is not confirmed. Wait for it before excluding these conversations.");
        // This shares the scheduler's lane: saving a narrower scope cannot
        // acknowledge cancellation while a release is still in flight.
        value.stops = value.stops.filter((stop) => open.has(stop.agentId));
        value.stoppedIds = value.stoppedIds.filter((id) => open.has(id));
        await save(value);
        return { ...value.management };
      });
    },
    register(ownerId: string) {
      return serialize(async () => {
        const result = leases.claim(await reconcileOwners(), ownerId);
        await save(result.state);
        return result.epoch;
      });
    },
    publish(report: TabReport) {
      return serialize(async () => {
        const result = leases.renew(await current(), report);
        if (result.dirty) await save(result.state);
        return result.accepted;
      });
    },
    list(): Promise<Inventory> {
      return serialize(async () => {
        let value = await reconcileOwners();
        const supported = api !== null && api.supported();
        const open = await managedMembership(value);
        const runtimes = await snapshots(open);
        const stoppedIds = stillStopped(value, runtimes, open);
        if (stoppedIds.length !== value.stoppedIds.length) {
          value = { ...value, stoppedIds };
          // A failed write only delays this cleanup to the next listing.
          await save(value).catch(() => {});
        }
        const rows: Row[] = [];
        for (const [id, presence] of open) {
          const runtime = runtimes.get(id) ?? missing(id);
          const { confirmed: _confirmed, ...visiblePresence } = presence;
          rows.push({
            runtime,
            ...visiblePresence,
            stopped:
              runtime.presence === "absent" && value.stoppedIds.includes(id),
            stop: value.stops.find((stop) => stop.agentId === id) ?? null,
          });
        }
        return {
          supported,
          reason: supported
            ? null
            : "Process control is unavailable on this host. Compatibility controls currently require Linux or Windows.",
          revision: value.revision,
          rows,
        };
      });
    },
    change(input: StopChange) {
      return serialize(async () => {
        const value = structuredClone(await reconcileOwners());
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
        const open = await managedMembership(value);
        if (!open.has(input.agentId))
          return {
            changed: false,
            reason: "This conversation is outside the managed open tabs.",
          };
        if (!open.get(input.agentId)?.confirmed)
          return {
            changed: false,
            reason: "Open tabs are waiting to resynchronize.",
          };
        const runtime = (await snapshots(open, [input.agentId])).get(
          input.agentId,
        );
        if (
          !runtime ||
          !(input.action === "schedule"
            ? (runtime.schedulable ?? runtime.releasable)
            : runtime.releasable) ||
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
