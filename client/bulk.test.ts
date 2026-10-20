import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../shared/model";
import { controlReason, runBulkControl, type ControlInput } from "./bulk";

function row(id: string, overrides: Partial<Row["runtime"]> = {}): Row {
  return {
    runtime: {
      agentId: id, title: `Conversation ${id}`, workspace: "test", provider: "codex",
      generation: `${id}:1`, presence: "running", activity: "idle", memoryBytes: 1024,
      releasable: true, unavailableReason: null, ...overrides,
    },
    ownerCount: 1, hasSharedTabs: false, syncPending: false, stopped: false, stop: null,
  };
}
function scheduled(id: string): Row {
  return { ...row(id), stop: {
    id: `stop:${id}`, agentId: id, generation: `${id}:1`, dueAt: 123,
    state: "scheduled", error: null,
  } };
}

test("eligibility distinguishes scheduling, stopping, cancellation and missing processes", () => {
  const scheduleOnly = row("bridge", { releasable: false, schedulable: true });
  assert.equal(controlReason(scheduleOnly, "schedule", true), null);
  assert.ok(controlReason(scheduleOnly, "now", true));
  assert.ok(controlReason(row("missing", { presence: "absent" }), "schedule", true));
  assert.ok(controlReason(row("unknown", { generation: null }), "now", true));
  assert.ok(controlReason(row("unsupported"), "now", false));
  assert.equal(controlReason(scheduled("cancel"), "cancel", false), null);
  assert.ok(controlReason(row("no-schedule"), "cancel", true));
  const stopping = scheduled("stopping");
  stopping.stop!.state = "stopping";
  for (const action of ["schedule", "cancel", "now"] as const)
    assert.ok(controlReason(stopping, action, true));
});

test("batch continues after transport and guarded failures and reports skips separately", async () => {
  const inputs: ControlInput[] = [];
  const progress: number[] = [];
  const result = await runBulkControl([
    row("success"), row("transport"), scheduled("changed"),
    row("absent", { presence: "absent", generation: null }), row("working", { activity: "working" }),
  ], "now", true, undefined, async input => {
    inputs.push(input);
    if (input.agentId === "transport") throw new Error("Connection lost");
    if (input.agentId === "changed") return { changed: false, reason: "Stop policy changed" };
    return { changed: true, reason: null };
  }, count => progress.push(count));
  assert.deepEqual(result.succeeded, ["success", "working"]);
  assert.deepEqual(result.failed.map(issue => [issue.agentId, issue.reason]), [
    ["transport", "Connection lost"], ["changed", "Stop policy changed"],
  ]);
  assert.equal(result.skipped[0].agentId, "absent");
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.equal(inputs.find(input => input.agentId === "changed")?.expectedStopId, "stop:changed");
  assert.equal(inputs.find(input => input.agentId === "working")?.action, "now");
});

test("batch preserves reviewed generation and stop IDs and sends requests sequentially", async () => {
  const rows = [scheduled("a"), row("b")];
  const inputs: ControlInput[] = [];
  let active = 0;
  const result = await runBulkControl(rows, "schedule", true, 2, async input => {
    assert.equal(active++, 0);
    await new Promise(resolve => setImmediate(resolve));
    inputs.push(input);
    active--;
    return { changed: true, reason: null };
  });
  assert.deepEqual(result.succeeded, ["a", "b"]);
  assert.deepEqual(inputs, [
    { agentId: "a", expectedGeneration: "a:1", expectedStopId: "stop:a", action: "schedule", hours: 2 },
    { agentId: "b", expectedGeneration: "b:1", expectedStopId: null, action: "schedule", hours: 2 },
  ]);
});

test("cancel only touches pending policies, even on an unsupported host", async () => {
  const inputs: ControlInput[] = [];
  const result = await runBulkControl([scheduled("a"), row("b")], "cancel", false, undefined, async input => {
    inputs.push(input);
    return { changed: true, reason: null };
  });
  assert.deepEqual(result.succeeded, ["a"]);
  assert.equal(result.skipped[0].agentId, "b");
  assert.deepEqual(inputs, [{ agentId: "a", expectedGeneration: "a:1", expectedStopId: "stop:a", action: "cancel" }]);
});
