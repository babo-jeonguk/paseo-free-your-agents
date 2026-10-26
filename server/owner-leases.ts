import { randomUUID } from "node:crypto";
import type { State } from "./store";

export const OWNER_FRESH_MS = 45_000;
export const OWNER_RETIRE_MS = 24 * 60 * 60_000;
const OWNER_CHECKPOINT_MS = 5 * 60_000;

export interface OwnerReport {
  ownerId: string;
  epoch: string;
  revision: number;
  agentIds: string[];
  sharedAgentIds?: string[];
}

export interface MembershipPresence {
  ownerCount: number;
  syncPending: boolean;
  hasSharedTabs: boolean;
  confirmed: boolean;
}

function normalize(report: OwnerReport) {
  const agentIds = [...new Set(report.agentIds)].sort();
  return {
    agentIds,
    sharedAgentIds: [...new Set(report.sharedAgentIds ?? [])]
      .filter((id) => agentIds.includes(id))
      .sort(),
  };
}

export function createOwnerLeaseRegistry(now: () => number = Date.now) {
  // Frequent heartbeats stay in memory. A coarse persisted checkpoint lets a
  // restarted daemon retire abandoned owners without rewriting state every 15s.
  const seen = new Map<string, number>();
  const lastSeen = (owner: State["owners"][number]) => seen.get(owner.id) ?? owner.seenAt;

  function membership(state: State) {
    const rows = new Map<string, MembershipPresence>();
    for (const owner of state.owners) {
      // After daemon restart, persisted owners are suspect until the window
      // renews this process's in-memory lease.
      const stale = !seen.has(owner.id) || now() - lastSeen(owner) > OWNER_FRESH_MS;
      for (const id of owner.agentIds) {
        const row = rows.get(id) ?? {
          ownerCount: 0,
          syncPending: false,
          hasSharedTabs: false,
          confirmed: false,
        };
        row.ownerCount += 1;
        row.syncPending ||= stale;
        row.hasSharedTabs ||= owner.sharedAgentIds.includes(id);
        row.confirmed ||= !stale;
        rows.set(id, row);
      }
    }
    return rows;
  }

  function pruneOrphans(state: State, open: Map<string, MembershipPresence>) {
    state.stops = state.stops.filter(
      (stop) => open.has(stop.agentId) || stop.state === "stopping",
    );
    state.stoppedIds = state.stoppedIds.filter((id) => open.has(id));
  }

  function reconcile(input: State) {
    const protectedIds = new Set(
      input.stops.filter((stop) => stop.state === "stopping").map((stop) => stop.agentId),
    );
    const retired = input.owners.filter(
      (owner) =>
        now() - lastSeen(owner) > OWNER_RETIRE_MS &&
        !owner.agentIds.some((id) => protectedIds.has(id)),
    );
    const currentMembership = membership(input);
    const hasOrphans =
      input.stops.some(
        (stop) => !currentMembership.has(stop.agentId) && stop.state !== "stopping",
      ) || input.stoppedIds.some((id) => !currentMembership.has(id));
    if (!retired.length && !hasOrphans)
      return { state: input, membership: currentMembership, dirty: false };

    const retiredIds = new Set(retired.map((owner) => owner.id));
    for (const id of retiredIds) seen.delete(id);
    const state = structuredClone(input);
    state.owners = state.owners.filter((owner) => !retiredIds.has(owner.id));
    const open = membership(state);
    pruneOrphans(state, open);
    return { state, membership: open, dirty: true };
  }

  function claim(input: State, ownerId: string) {
    const state = structuredClone(input);
    const previous = state.owners.find((owner) => owner.id === ownerId);
    const epoch = randomUUID();
    state.owners = state.owners.filter((owner) => owner.id !== ownerId);
    state.owners.push({
      id: ownerId,
      epoch,
      revision: -1,
      agentIds: previous?.agentIds ?? [],
      sharedAgentIds: previous?.sharedAgentIds ?? [],
      seenAt: previous?.seenAt ?? now(),
    });
    seen.delete(ownerId);
    return { state, epoch };
  }

  function renew(input: State, report: OwnerReport) {
    const owner = input.owners.find((entry) => entry.id === report.ownerId);
    if (!owner || owner.epoch !== report.epoch || report.revision < owner.revision)
      return { state: input, accepted: false, dirty: false };
    const { agentIds, sharedAgentIds } = normalize(report);
    if (report.revision === owner.revision) {
      if (
        JSON.stringify(agentIds) !== JSON.stringify(owner.agentIds) ||
        JSON.stringify(sharedAgentIds) !== JSON.stringify(owner.sharedAgentIds)
      )
        return { state: input, accepted: false, dirty: false };
      seen.set(owner.id, now());
      if (now() - owner.seenAt < OWNER_CHECKPOINT_MS)
        return { state: input, accepted: true, dirty: false };
    }

    const state = structuredClone(input);
    const next = state.owners.find((entry) => entry.id === owner.id)!;
    next.revision = report.revision;
    next.agentIds = agentIds;
    next.sharedAgentIds = sharedAgentIds;
    next.seenAt = now();
    seen.set(owner.id, now());
    const reconciled = reconcile(state);
    return { state: reconciled.state, accepted: true, dirty: true };
  }

  return { claim, membership, renew, reconcile };
}
