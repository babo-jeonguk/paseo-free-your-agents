import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerLeaseRegistry, OWNER_RETIRE_MS } from "./owner-leases";
import { emptyState } from "./store";

function fixture() {
  let clock = 100_000;
  const leases = createOwnerLeaseRegistry(() => clock);
  let state = emptyState();
  const claimed = leases.claim(state, "window");
  state = claimed.state;
  state = leases.renew(state, {
    ownerId: "window",
    epoch: claimed.epoch,
    revision: 0,
    agentIds: ["a"],
  }).state;
  return {
    leases,
    state: () => state,
    setState: (value: typeof state) => (state = value),
    advance: (ms: number) => (clock += ms),
  };
}

test("owner leases retain suspect tabs but revoke confirmed stop authority", () => {
  const f = fixture();
  f.advance(46_000);
  const scope = f.leases.reconcile(f.state());
  assert.equal(scope.membership.get("a")?.syncPending, true);
  assert.equal(scope.membership.get("a")?.confirmed, false);
  assert.equal(scope.state.owners.length, 1);
});

test("owner leases automatically retire abandoned ownership and pending policy", () => {
  const f = fixture();
  const state = structuredClone(f.state());
  state.stops.push({
    id: "stop",
    agentId: "a",
    generation: "generation",
    dueAt: 0,
    state: "scheduled",
    error: null,
  });
  state.stoppedIds.push("a");
  f.setState(state);
  f.advance(OWNER_RETIRE_MS + 1);
  const scope = f.leases.reconcile(f.state());
  assert.equal(scope.state.owners.length, 0);
  assert.equal(scope.state.stops.length, 0);
  assert.equal(scope.state.stoppedIds.length, 0);
  assert.equal(scope.membership.size, 0);
});

test("owner leases preserve ownership while a stop result is unconfirmed", () => {
  const f = fixture();
  const state = structuredClone(f.state());
  state.stops.push({
    id: "stop",
    agentId: "a",
    generation: "generation",
    dueAt: 0,
    state: "stopping",
    error: null,
  });
  f.advance(OWNER_RETIRE_MS + 1);
  const scope = f.leases.reconcile(state);
  assert.equal(scope.state.owners.length, 1);
  assert.equal(scope.state.stops.length, 1);
});
