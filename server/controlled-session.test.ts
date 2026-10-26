import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlledSession } from "./runtime/controlled-session.mjs";
import type { ReleaseEvidence } from "./runtime/release-evidence.mjs";

const safeEvidence = (): ReleaseEvidence => ({
  protocolSupported: true,
  trackingComplete: true,
  inventoryComplete: true,
  pendingWork: 0,
  subjects: [
    { execution: "settled", goal: "complete", background: "none", scheduled: "none" },
  ],
  resumeDurable: true,
  stable: true,
});

test("a replacement child rejects output from an earlier incarnation", () => {
  const session = createControlledSession<{ incarnation?: number }>();
  const first = session.control({ op: "replace" });
  const second = session.control({ op: "replace" });

  const stale = session.exchange("provider", { incarnation: first });
  const current = session.exchange("provider", { incarnation: second });

  assert.equal(stale.accepted, false);
  assert.equal(current.accepted, true);
});

test("provider activity invalidates the proof epoch but internal probe replies do not", () => {
  const session = createControlledSession<{ incarnation: number; activity: boolean }>({
    isActivityProviderFrame: (frame) => frame.activity,
  });
  const incarnation = session.control({ op: "replace" });
  const passiveCheckpoint = session.control({ op: "checkpoint" });
  session.exchange("provider", { incarnation, activity: false }).settle();
  assert.equal(
    session.control({ op: "release", checkpoint: passiveCheckpoint, evidence: safeEvidence() })
      .status,
    "safe",
  );

  const activityCheckpoint = session.control({ op: "checkpoint" });
  session.exchange("provider", { incarnation, activity: true }).settle();
  assert.equal(
    session.control({ op: "release", checkpoint: activityCheckpoint, evidence: safeEvidence() })
      .status,
    "busy",
  );
});
