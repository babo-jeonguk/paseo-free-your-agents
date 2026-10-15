import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateTabs } from "./private-tabs";
import type { LocalTabsState } from "../shared/model";

const pane = (targets: unknown[]) => ({
  root: { kind: "pane", pane: { tabs: targets.map((target) => ({ target })) } },
});
test("private tab adapter waits for hydration and ownership, isolates hosts, and groups child-only tabs", async () => {
  let hydrated = false,
    ownerResolve: (id: string) => void = () => {};
  const owner = new Promise<string>((resolve) => {
    ownerResolve = resolve;
  });
  let state = {
    layoutByWorkspace: {
      "one:active": pane([{ kind: "agent", agentId: "codex" }]),
      "one:inactive": pane([
        {
          kind: "provider_subagent",
          parentAgentId: "parent",
          subagentId: "child",
        },
      ]),
      "two:other": pane([{ kind: "agent", agentId: "other-host" }]),
    },
    sheetByWorkspace: {
      "one:preview": {
        tab: { target: { kind: "agent", agentId: "preview-only" } },
      },
    },
  };
  const listeners = new Set<() => void>(),
    hydrate = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    persist: {
      hasHydrated: () => hydrated,
      onFinishHydration: (listener: () => void) => {
        hydrate.add(listener);
        return () => {
          hydrate.delete(listener);
        };
      },
    },
  };
  const snapshots: LocalTabsState[] = [],
    errors: string[] = [];
  const source = createPrivateTabs({
    hostId: "one",
    owner: () => owner,
    onError: (message) => errors.push(message),
  });
  const unsubscribe = source.api.observe((snapshot) => snapshots.push(snapshot));
  source.attach({
    __internalInstanceHandle: {
      memoizedState: { memoizedState: [() => {}, [store]], next: null },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(snapshots.every((snapshot) => snapshot.status === "loading"));
  ownerResolve("window");
  await new Promise(setImmediate);
  assert.ok(snapshots.every((snapshot) => snapshot.status === "loading"));
  hydrated = true;
  for (const listener of hydrate) listener();
  assert.deepEqual(snapshots.at(-1), {
    status: "ready",
    ownerId: "window",
    revision: 1,
    agentIds: ["codex", "parent"],
    sharedAgentIds: ["parent"],
  });
  assert.equal(source.supported(), true);
  // A hidden/unmounted sidebar does not close any conversation or observation.
  source.attach(null);
  state.layoutByWorkspace["one:active"] = pane([]);
  for (const listener of listeners) listener();
  assert.deepEqual(snapshots.at(-1)!.agentIds, ["parent"]);
  state.layoutByWorkspace["one:inactive"] = {
    root: null,
  } as unknown as ReturnType<typeof pane>;
  for (const listener of listeners) listener();
  assert.equal(source.supported(), false);
  assert.equal(snapshots.at(-1)!.status, "loading");
  assert.ok(
    !snapshots.some((snapshot) => snapshot.status === "ready" && snapshot.agentIds.length === 0),
  );
  state.layoutByWorkspace["one:inactive"] = pane([]);
  for (const listener of listeners) listener();
  assert.equal(source.supported(), true);
  assert.deepEqual(snapshots.at(-1)!.agentIds, []);
  assert.equal(errors.length, 1);
  unsubscribe();
  source.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(hydrate.size, 0);
});
