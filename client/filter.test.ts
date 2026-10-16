import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../shared/model";
import {
  category,
  controlNote,
  filters,
  matches,
  memoryTotal,
  pendingStop,
  processTotal,
  statusLabel,
  visible,
} from "./filter";

function row(
  id: string,
  absent: boolean,
  stop: NonNullable<Row["stop"]>["state"] | null
): Row {
  return {
    ownerCount: 1,
    hasSharedTabs: false,
    syncPending: false,
    stopped: false,
    runtime: {
      agentId: id,
      title: id,
      provider: "codex",
      workspace: "workspace",
      generation: absent ? null : "generation",
      presence: absent ? "absent" : "running",
      activity: "idle",
      memoryBytes: 0,
      releasable: !absent,
      unavailableReason: null,
    },
    stop: stop
      ? {
          id: `stop-${id}`,
          agentId: id,
          generation: "generation",
          dueAt: 0,
          state: stop,
          error: null,
        }
      : null,
  };
}
test("OR filters combine separate categories, retain stopped conversations and narrow by search", () => {
  const rows = [
    row("idle", false, "scheduled"),
    row("working", false, "deferred"),
    row("stopped", true, null),
    row("unknown", false, null),
  ];
  rows[1].runtime.activity = "working";
  rows[3].runtime.presence = "unknown";
  assert.deepEqual(
    visible(rows, ["idle", "working"], "").map((row) => row.runtime.agentId),
    ["idle", "working"]
  );
  assert.equal(visible(rows, ["idle", "unknown"], "").length, 2);
  assert.equal(visible(rows, ["unknown", "absent"], "").length, 2);
  assert.deepEqual(
    visible(rows, ["idle", "absent"], "stopped").map((row) => row.runtime.agentId),
    ["stopped"]
  );
});

test("every presence and activity belongs to exactly one category; counts sum to All", () => {
  const rows: Row[] = [];
  const activities = ["idle", "working", "background", "unknown"] as const;
  const expectedCategories = {
    running: ["idle", "working", "working", "unknown"],
    absent: ["absent", "absent", "absent", "absent"],
    unknown: ["unknown", "unknown", "unknown", "unknown"],
  } as const;
  for (const presence of ["running", "absent", "unknown"] as const) {
    for (const [index, activity] of activities.entries()) {
      const entry = row(`${presence}-${activity}`, presence === "absent", null);
      entry.runtime.presence = presence;
      entry.runtime.activity = activity;
      rows.push(entry);
      const expected = expectedCategories[presence][index];
      assert.equal(category(entry), expected, entry.runtime.agentId);
      assert.deepEqual(
        filters.filter((filter) => matches(entry, filter.id)).map((filter) => filter.id),
        [expected],
        entry.runtime.agentId,
      );
    }
  }
  assert.equal(
    filters.reduce((count, filter) => count + visible(rows, [filter.id], "").length, 0),
    visible(rows, [], "").length,
  );
  assert.deepEqual(visible(rows, filters.map((filter) => filter.id), ""), rows);
});

test("stop state, memory and releasability never change the work-status category", () => {
  for (const stop of [null, "scheduled", "deferred", "stopping", "failed"] as const) {
    const idle = row(`idle-${stop}`, false, stop);
    idle.runtime.memoryBytes = null;
    idle.runtime.releasable = false;
    assert.equal(category(idle), "idle", String(stop));
    assert.equal(statusLabel(idle), "Idle", String(stop));
  }
  const stale = row("stale", true, "scheduled");
  stale.runtime.memoryBytes = null;
  assert.equal(category(stale), "absent");
});

test("pending stops count scheduled, deferred and stopping stops of present processes", () => {
  const states = [null, "scheduled", "deferred", "stopping", "failed"] as const;
  assert.deepEqual(
    states.map((stop) => pendingStop(row(String(stop), false, stop))),
    [false, true, true, true, false],
  );
  assert.equal(pendingStop(row("absent", true, "scheduled")), false);
  const unknown = row("unknown", false, "deferred");
  unknown.runtime.presence = "unknown";
  assert.equal(pendingStop(unknown), true);
});

test("an adoption-pending conversation stays visible and is not classified as process-free", () => {
  const pending = row("pending", false, null);
  pending.runtime = {
    ...pending.runtime,
    presence: "unknown",
    generation: null,
    releasable: false,
    controlStatus: "after-restart",
    memoryBytes: null,
  };
  assert.equal(statusLabel(pending), "Status unavailable");
  assert.equal(controlNote(pending), "Applies after restart");
  assert.deepEqual(visible([pending], [], ""), [pending]);
  assert.deepEqual(visible([pending], ["absent"], ""), []);
  assert.deepEqual(visible([pending], ["unknown"], ""), [pending]);
});

test("totals sum measured rows and mark unmeasured ones as a lower bound", () => {
  const MiB = 1024 * 1024;
  const measured = (id: string, mib: number) => {
    const value = row(id, false, null);
    value.runtime.memoryBytes = mib * MiB;
    return value;
  };
  const unknown = (id: string) => {
    const value = row(id, false, null);
    value.runtime.presence = "unknown";
    value.runtime.memoryBytes = null;
    return value;
  };
  const stopped = row("stopped", true, null);
  assert.deepEqual(memoryTotal([measured("a", 200), measured("b", 97), stopped]), {
    value: "297\u00a0MB",
    caption: null,
    accessibilityLabel: "Process memory: 297 megabytes.",
  });
  assert.deepEqual(memoryTotal([measured("a", 297), unknown("u1"), unknown("u2")]), {
    value: "297+\u00a0MB",
    caption: "2 not measured",
    accessibilityLabel: "Process memory: at least 297 megabytes. 2 conversations not measured.",
  });
  assert.equal(memoryTotal([stopped]).value, "0\u00a0MB");
  assert.equal(memoryTotal([]).value, "0\u00a0MB");
  assert.deepEqual(memoryTotal([stopped, unknown("u")]), {
    value: "Not measured",
    caption: "1 not measured",
    accessibilityLabel: "Process memory: not measured. 1 conversation not measured.",
  });
  assert.equal(memoryTotal([measured("big", 42_270), unknown("u")]).value, "41.3+\u00a0GB");
  assert.deepEqual(processTotal([measured("a", 1), stopped, unknown("u")]), {
    value: "1+",
    caption: "1 unknown",
    accessibilityLabel: "Processes: at least 1 running. 1 conversation unknown.",
  });
  assert.equal(processTotal([measured("a", 1), stopped]).value, "1");
  assert.equal(processTotal([unknown("u")]).value, "Unknown");
});
