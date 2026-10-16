import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControl } from "./control";
import { createFileStore } from "./store";
import type { Runtime, RuntimeApi } from "../shared/model";

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "free-your-agents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 100_000;
  const store = createFileStore(join(directory, "state.json"));
  const control = createControl(store, () => clock);
  const runtimes = new Map<string, Runtime>();
  runtimes.set("a", {
    agentId: "a",
    title: "Codex conversation",
    provider: "codex",
    workspace: "workspace",
    generation: "boot:1",
    presence: "running",
    activity: "idle",
    memoryBytes: 1234,
    releasable: true,
    unavailableReason: null,
  });
  runtimes.set("b", {
    ...runtimes.get("a")!,
    agentId: "b",
    provider: "claude",
    presence: "absent",
    generation: null,
    memoryBytes: 0,
    releasable: false,
  });
  const releases: string[] = [];
  const api: RuntimeApi = {
    supported: () => true,
    snapshot: async ({ agentIds }) =>
      agentIds.map((id) => structuredClone(runtimes.get(id)!)),
    releaseIfIdle: async ({ agentId, expectedGeneration }) => {
      const runtime = runtimes.get(agentId)!;
      if (runtime.generation !== expectedGeneration)
        return { status: "generation-changed", error: null };
      if (runtime.activity !== "idle") return { status: "busy", error: null };
      releases.push(agentId);
      runtimes.set(agentId, {
        ...runtime,
        generation: null,
        presence: "absent",
        memoryBytes: 0,
      });
      return { status: "released", error: null };
    },
  };
  control.attach(api);
  async function owner(id: string, agentIds: string[]) {
    const epoch = await control.register(id);
    await control.publish({ ownerId: id, epoch, revision: 0, agentIds });
    return epoch;
  }
  return {
    store,
    control,
    runtimes,
    releases,
    api,
    owner,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("open tabs are deduplicated across devices and include process-free Claude", async (t) => {
  const { control, owner } = await setup(t);
  const desktop = await owner("desktop", ["a", "a", "b"]);
  const phone = await owner("phone", ["a"]);
  let inventory = await control.list();
  assert.deepEqual(
    inventory.rows.map((row) => [row.runtime.agentId, row.ownerCount]),
    [
      ["a", 2],
      ["b", 1],
    ],
  );
  await control.publish({
    ownerId: "desktop",
    epoch: desktop,
    revision: 1,
    agentIds: ["b"],
  });
  assert.equal(
    (await control.list()).rows.some((row) => row.runtime.agentId === "a"),
    true,
  );
  await control.publish({
    ownerId: "phone",
    epoch: phone,
    revision: 1,
    agentIds: [],
  });
  inventory = await control.list();
  assert.deepEqual(
    inventory.rows.map((row) => row.runtime.agentId),
    ["b"],
  );
});

test("scheduler skips unrequested runtimes and observes only conversations with pending state", async (t) => {
  const f = await setup(t);
  await f.owner("desktop", ["a", "b"]);
  const calls: string[][] = [];
  f.control.attach({
    ...f.api,
    snapshot: async (input) => {
      calls.push(input.agentIds);
      return f.api.snapshot(input);
    },
  });
  await f.control.tick();
  assert.deepEqual(calls, []);
  await f.control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "schedule",
    hours: 1,
  });
  calls.length = 0;
  await f.control.tick();
  assert.deepEqual(calls, [["a"]]);
});

test("child-only tabs retain one parent process across owners and revision shared metadata", async (t) => {
  const { control, owner } = await setup(t);
  const desktop = await owner("desktop", ["a"]);
  const phone = await control.register("phone");
  await control.publish({
    ownerId: "phone",
    epoch: phone,
    revision: 0,
    agentIds: ["a"],
    sharedAgentIds: ["a"],
  });
  let rows = (await control.list()).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasSharedTabs, true);
  assert.equal(rows[0].runtime.memoryBytes, 1234);
  assert.equal(rows[0].ownerCount, 2);
  assert.equal(
    await control.publish({
      ownerId: "phone",
      epoch: phone,
      revision: 0,
      agentIds: ["a"],
    }),
    false,
  );
  await control.publish({
    ownerId: "desktop",
    epoch: desktop,
    revision: 1,
    agentIds: [],
  });
  rows = (await control.list()).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasSharedTabs, true);
  await control.publish({
    ownerId: "phone",
    epoch: phone,
    revision: 1,
    agentIds: [],
  });
  assert.equal((await control.list()).rows.length, 0);
});

test("process stop keeps its row, consumes its policy, and cancellation never starts a process", async (t) => {
  const { control, owner, releases } = await setup(t);
  await owner("desktop", ["a"]);
  assert.deepEqual(
    await control.change({
      agentId: "a",
      expectedGeneration: "boot:1",
      expectedStopId: null,
      action: "now",
    }),
    { changed: true, reason: null },
  );
  const [row] = (await control.list()).rows;
  assert.equal(row.runtime.presence, "absent");
  assert.equal(row.stopped, true);
  assert.equal(row.stop, null);
  await control.tick();
  assert.deepEqual(releases, ["a"]);
  await control.change({
    agentId: "a",
    expectedGeneration: null,
    expectedStopId: null,
    action: "cancel",
  });
  assert.equal((await control.list()).rows[0].runtime.presence, "absent");
});

test("stopped conversations are not polled in the background and reconcile when listed", async (t) => {
  const { control, owner, runtimes, api } = await setup(t);
  const epoch = await owner("desktop", ["a"]);
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "now",
  });
  let snapshots = 0;
  const snapshot = api.snapshot;
  api.snapshot = (input) => {
    snapshots++;
    return snapshot(input);
  };
  await control.tick();
  assert.equal(snapshots, 0, "No pending stop: the scheduler leaves runtimes alone");
  assert.equal((await control.list()).rows[0].stopped, true);
  // The next message resumes the same conversation.
  runtimes.set("a", { ...runtimes.get("a")!, presence: "running", generation: "boot:2" });
  assert.equal((await control.list()).rows[0].stopped, false);
  runtimes.set("a", { ...runtimes.get("a")!, presence: "absent", generation: null });
  assert.equal(
    (await control.list()).rows[0].stopped,
    false,
    "A later absence without a stop is not labeled as stopped",
  );
  await control.change({
    agentId: "a",
    expectedGeneration: null,
    expectedStopId: null,
    action: "cancel",
  });
  assert.equal(
    await control.publish({ ownerId: "desktop", epoch, revision: 1, agentIds: [] }),
    true,
  );
  assert.deepEqual((await control.list()).rows, []);
});

test("the fixed deadline is deferred through foreground and background work", async (t) => {
  const { control, owner, runtimes, releases, advance } = await setup(t);
  await owner("desktop", ["a"]);
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "schedule",
    hours: 1,
  });
  advance(3_600_000);
  runtimes.get("a")!.activity = "working";
  await control.tick();
  const stop = (await control.list()).rows[0].stop!;
  assert.equal(stop.state, "deferred");
  assert.equal(stop.dueAt, 3_700_000);
  runtimes.get("a")!.activity = "background";
  await control.tick();
  assert.deepEqual(releases, []);
  runtimes.get("a")!.activity = "idle";
  await control.tick();
  assert.deepEqual(releases, ["a"]);
});

test("old reports, stale edits, and cancelled retries cannot change newer state", async (t) => {
  const { control, owner, releases, advance } = await setup(t);
  const epoch = await owner("desktop", ["a"]);
  assert.equal(
    await control.publish({
      ownerId: "desktop",
      epoch,
      revision: 0,
      agentIds: [],
    }),
    false,
  );
  const nextEpoch = await control.register("desktop");
  assert.equal(
    await control.publish({
      ownerId: "desktop",
      epoch,
      revision: 100,
      agentIds: [],
    }),
    false,
  );
  await control.publish({
    ownerId: "desktop",
    epoch: nextEpoch,
    revision: 0,
    agentIds: ["a"],
  });
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "schedule",
    hours: 1,
  });
  assert.equal(
    (
      await control.change({
        agentId: "a",
        expectedGeneration: "boot:1",
        expectedStopId: null,
        action: "now",
      })
    ).changed,
    false,
  );
  const stop = (await control.list()).rows[0].stop!;
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: stop.id,
    action: "cancel",
  });
  advance(3_600_000);
  await control.tick();
  assert.deepEqual(releases, []);
});

test("persisted schedules never stop a new runtime after daemon restart", async (t) => {
  const { control, owner, store, runtimes, api, releases, advance } =
    await setup(t);
  await owner("desktop", ["a"]);
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "schedule",
    hours: 1,
  });
  advance(3_600_000);
  runtimes.get("a")!.generation = "new-boot:1";
  const restarted = createControl(store);
  restarted.attach(api);
  assert.equal((await restarted.list()).rows[0].syncPending, true);
  await restarted.tick();
  assert.equal((await restarted.list()).rows[0].stop, null);
  assert.deepEqual(releases, []);
});

test("unsupported hosts and release failures leave the conversation and policy visible", async (t) => {
  const { control, owner, api } = await setup(t);
  await owner("desktop", ["a"]);
  control.attach(null);
  assert.equal((await control.list()).supported, false);
  assert.equal(
    (
      await control.change({
        agentId: "a",
        expectedGeneration: "boot:1",
        expectedStopId: null,
        action: "now",
      })
    ).changed,
    false,
  );
  control.attach({
    ...api,
    releaseIfIdle: async () => ({
      status: "failed",
      error: "Exit was not confirmed",
    }),
  });
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "now",
  });
  const row = (await control.list()).rows[0];
  assert.equal(row.stop!.state, "failed");
  assert.equal(row.stop!.error, "Exit was not confirmed");
  assert.equal(row.runtime.presence, "running");
});

test("a lost release response cannot be acknowledged as cancelled while the daemon may still stop the process", async (t) => {
  const { control, owner, api, runtimes } = await setup(t);
  await owner("desktop", ["a"]);
  control.attach({
    ...api,
    releaseIfIdle: async () => {
      throw new Error("RPC timed out");
    },
  });
  await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: null,
    action: "now",
  });
  const stop = (await control.list()).rows[0].stop!;
  assert.equal(stop.state, "stopping");
  const cancelled = await control.change({
    agentId: "a",
    expectedGeneration: "boot:1",
    expectedStopId: stop.id,
    action: "cancel",
  });
  assert.equal(cancelled.changed, false);
  assert.match(cancelled.reason!, /already in progress/);
  runtimes.set("a", {
    ...runtimes.get("a")!,
    presence: "absent",
    generation: null,
    memoryBytes: 0,
  });
  await control.tick();
  assert.equal((await control.list()).rows[0].stop, null);
});

test("disconnected owners keep their last tabs as Sync pending", async (t) => {
  const { control, owner, advance } = await setup(t);
  await owner("desktop", ["a"]);
  advance(46_000);
  assert.equal((await control.list()).rows[0].syncPending, true);
  assert.equal((await control.list()).rows.length, 1);
});

test("periodic reports refresh freshness without rewriting state", async (t) => {
  const f = await setup(t);
  const epoch = await f.owner("desktop", ["a"]);
  const saved = (await f.store.read()).revision;
  f.advance(40_000);
  assert.equal(
    await f.control.publish({ ownerId: "desktop", epoch, revision: 0, agentIds: ["a"] }),
    true,
  );
  f.advance(40_000);
  assert.equal((await f.control.list()).rows[0]!.syncPending, false);
  assert.equal((await f.store.read()).revision, saved);
  f.advance(10_000);
  assert.equal((await f.control.list()).rows[0]!.syncPending, true);
  assert.equal(
    await f.control.publish({ ownerId: "desktop", epoch, revision: 0, agentIds: ["b"] }),
    false,
  );
});
