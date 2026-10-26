import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateReleaseEvidence,
  type ReleaseEvidence,
} from "./runtime/release-evidence.mjs";

const safe = (): ReleaseEvidence => ({
  protocolSupported: true,
  trackingComplete: true,
  inventoryComplete: true,
  pendingWork: 0,
  subjects: [
    {
      execution: "settled",
      goal: "complete",
      background: "none",
      scheduled: "none",
    },
  ],
  resumeDurable: true,
  stable: true,
});

test("release evidence accepts complete stable proof independent of a provider version", () => {
  assert.deepEqual(evaluateReleaseEvidence(safe()), { status: "safe" });
});

test("release evidence fails closed for unknown provider facts", () => {
  const evidence = safe();
  evidence.subjects[0]!.execution = "unknown";
  assert.equal(evaluateReleaseEvidence(evidence).status, "unsupported");
});

test("release evidence fails closed for missing and malformed facts", () => {
  for (const subjects of [
    [],
    [{}],
    [{ execution: "settled", goal: "new-state", background: "none", scheduled: "none" }],
  ]) {
    assert.equal(
      evaluateReleaseEvidence({ ...safe(), subjects } as ReleaseEvidence).status,
      "unsupported",
    );
  }
  assert.equal(
    evaluateReleaseEvidence({ ...safe(), pendingWork: -1 } as ReleaseEvidence).status,
    "unsupported",
  );
});

test("release evidence keeps active, pending, unsaved, and unstable work alive", () => {
  for (const mutate of [
    (value: ReturnType<typeof safe>) => (value.pendingWork = 1),
    (value: ReturnType<typeof safe>) => (value.subjects[0]!.background = "present"),
    (value: ReturnType<typeof safe>) => (value.resumeDurable = false),
    (value: ReturnType<typeof safe>) => (value.stable = false),
  ]) {
    const evidence = safe();
    mutate(evidence);
    assert.equal(evaluateReleaseEvidence(evidence).status, "busy");
  }
});
