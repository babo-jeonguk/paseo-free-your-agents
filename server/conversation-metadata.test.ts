import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi, PaseoAgentListResult, PaseoAgentListOptions } from "@getpaseo/client";
import { createConversationMetadata } from "./conversation-metadata";

// Deliberately only the public listing seam is available to the adapter.
function page(ids: string[], nextCursor: string | null = null): PaseoAgentListResult {
  return {
    requestId: "fixture",
    entries: ids.map((id) => ({
      agent: { id, title: " " + id + " ", provider: "codex", cwd: "/fixture" },
    })) as PaseoAgentListResult["entries"],
    pageInfo: { hasMore: nextCursor !== null, nextCursor, prevCursor: null },
  };
}
function agents(list: (options?: PaseoAgentListOptions) => Promise<PaseoAgentListResult>) {
  return { list } as Pick<PaseoApi["agents"], "list">;
}

test("metadata batches concurrent lookups, includes inactive conversations, and expires its cache", async () => {
  let now = 0;
  const calls: (PaseoAgentListOptions | undefined)[] = [];
  const read = createConversationMetadata({
    now: () => now,
    agents: agents(async (options) => {
      calls.push(options);
      return options?.page?.cursor ? page(["b"]) : page(["a", "unrequested"], "second");
    }),
  });
  assert.deepEqual(await read([]), []);
  assert.equal(calls.length, 0);
  const [first, second] = await Promise.all([read(["a", "b", "a"]), read(["b", "missing"])]);
  assert.deepEqual(
    first.map((entry) => entry.agentId),
    ["a", "b"],
  );
  assert.deepEqual(second, [
    { agentId: "b", title: "b", provider: "codex", workspace: "/fixture" },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    includeBackground: true,
    filter: { includeArchived: true },
    page: { limit: 200 },
  });
  assert.deepEqual(calls[1]?.page, { limit: 200, cursor: "second" });
  first[0]!.title = "caller mutation";
  assert.equal((await read(["a"]))[0]!.title, "a");
  now = 14_999;
  await read(["missing"]);
  assert.equal(calls.length, 2);
  now = 15_000;
  await read(["a"]);
  assert.equal(calls.length, 4);
});

test("failed or looping metadata pagination never installs a partial cache and can retry", async () => {
  let mode = "error",
    calls = 0;
  const read = createConversationMetadata({
    agents: agents(async () => {
      calls++;
      if (mode === "error") throw new Error("Fixture offline");
      if (mode === "loop") return page(["partial"], "repeated");
      return page(["complete"]);
    }),
  });
  await assert.rejects(read(["partial"]), /offline/);
  mode = "loop";
  await assert.rejects(read(["partial"]), /pagination/);
  assert.equal(calls, 3);
  mode = "ok";
  assert.deepEqual(
    (await read(["partial", "complete"])).map((entry) => entry.agentId),
    ["complete"],
  );
  assert.equal(calls, 4);
});
