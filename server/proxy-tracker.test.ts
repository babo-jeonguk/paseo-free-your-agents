import assert from "node:assert/strict";
import { test } from "node:test";
import { createProtocolTracker } from "./proxy-tracker.mjs";

test("pending metadata never evicts an approval and overflow invalidates safety permanently", () => {
  const tracker = createProtocolTracker({ maxEntries: 2 });
  assert.equal(tracker.add("approval"), true);
  assert.equal(tracker.add("approval"), true);
  assert.equal(tracker.set(1, { method: "read" }), true);
  assert.equal(tracker.add("overflow"), false);
  assert.equal(tracker.size, 2);
  assert.equal(tracker.get("approval"), null);
  assert.equal(tracker.valid(), false);
  tracker.delete("approval");
  tracker.delete(1);
  assert.equal(tracker.size, 0);
  assert.equal(tracker.valid(), false, "Completing tracked work cannot repair incomplete tracking");
});

test("pending IDs preserve number/string identity and reject duplicate IDs and oversized metadata", () => {
  const tracker = createProtocolTracker<{ method: string }>({ maxEntryBytes: 128 });
  assert.equal(tracker.set(1, { method: "one" }), true);
  assert.equal(tracker.set("1", { method: "other" }), true);
  assert.deepEqual(tracker.get(1), { method: "one" });
  assert.deepEqual(tracker.get("1"), { method: "other" });
  assert.equal(tracker.set(1, { method: "replacement" }), false);
  assert.deepEqual(tracker.get(1), { method: "one" });
  assert.equal(tracker.set("huge", { method: "x".repeat(1024) }), false);
  assert.equal(tracker.add("x".repeat(513)), false);
  assert.equal(tracker.add(null), false);
  assert.equal(tracker.size, 2);
});
