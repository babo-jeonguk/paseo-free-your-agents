import assert from "node:assert/strict";
import { test } from "node:test";
import { startReporter } from "./reporter";
import type { LocalTabsState } from "../shared/model";

test("hydration never reports empty tabs, and membership changed during registration is eventually delivered", async () => {
  let report: (state: LocalTabsState) => void = () => {};
  let registered: (epoch: string) => void = () => {};
  const registration = new Promise<string>((resolve) => {
    registered = resolve;
  });
  const received: Array<{
    ownerId: string;
    revision: number;
    agentIds: string[];
    sharedAgentIds?: string[];
  }> = [];
  let registrations = 0;
  const stop = startReporter(
    {
      observe(listener) {
        report = listener;
        return () => {};
      },
    },
    {
      register: () => {
        registrations += 1;
        return registration;
      },
      publish: async (input) => {
        received.push(input);
        return true;
      },
    },
    (error) => {
      throw error;
    },
    60_000,
  );
  try {
    report({ status: "loading", ownerId: "window", revision: 0, agentIds: [] });
    assert.equal(registrations, 0);
    report({ status: "ready", ownerId: "window", revision: 1, agentIds: ["a"] });
    report({
      status: "ready",
      ownerId: "window",
      revision: 2,
      agentIds: ["a", "b"],
      sharedAgentIds: ["b"],
    });
    registered("epoch");
    await new Promise(setImmediate);
    assert.deepEqual(
      received.map((entry) => entry.agentIds),
      [["a"], ["a", "b"]],
    );
    assert.deepEqual(
      received.map((entry) => entry.revision),
      [1, 2],
    );
    assert.equal(registrations, 1);
    assert.deepEqual(received.at(-1)?.sharedAgentIds, ["b"]);
  } finally {
    stop();
  }
  assert.equal(
    received.some((entry) => entry.agentIds.length === 0),
    false,
  );
});
