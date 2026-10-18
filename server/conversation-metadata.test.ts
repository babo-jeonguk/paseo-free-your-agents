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

test("metadata batches concurrent lookups, lists archived conversations only when needed, and expires its cache", async () => {
  let now = 0;
  const calls: (PaseoAgentListOptions | undefined)[] = [];
  const read = createConversationMetadata({
    now: () => now,
    agents: agents(async (options) => {
      calls.push(options);
      if (!options?.page?.cursor) return page(["a", "unrequested"], "second");
      return page(options.filter?.includeArchived ? ["b", "archived"] : ["b"]);
    }),
  });
  assert.deepEqual(await read([]), []);
  assert.equal(calls.length, 0);
  const [first, second] = await Promise.all([read(["a", "b", "a"]), read(["b"])]);
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
    filter: { includeArchived: false },
    page: { limit: 200 },
  });
  assert.deepEqual(calls[1]?.page, { limit: 200, cursor: "second" });
  const [archived, missing] = await Promise.all([read(["archived"]), read(["missing"])]);
  assert.deepEqual(
    archived.map((entry) => entry.agentId),
    ["archived"],
  );
  assert.deepEqual(missing, []);
  assert.equal(calls.length, 4, "One archived listing serves every missing conversation");
  assert.equal(calls[2]?.filter?.includeArchived, true);
  first[0]!.title = "caller mutation";
  assert.equal((await read(["a"]))[0]!.title, "a");
  now = 14_999;
  await read(["missing"]);
  assert.equal(calls.length, 4);
  now = 15_000;
  await read(["a"]);
  assert.equal(calls.length, 6);
  assert.equal(calls[4]?.filter?.includeArchived, false);
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
  assert.equal(calls, 5, "The missing conversation is also looked up among archived ones");
});

test("foreground lookup leaves background visibility to the host, including archived tabs", async () => {
  const calls: unknown[] = [];
  const read = createConversationMetadata({
    includeBackground: false,
    agents: agents(async (options) => {
      calls.push(options);
      return page(options?.filter?.includeArchived ? ["foreground", "archived"] : ["foreground"]);
    }),
  });
  assert.deepEqual((await read(["foreground", "background", "archived"])).map((entry) => entry.agentId), ["foreground", "archived"]);
  assert.deepEqual(calls, [
    { includeBackground: false, filter: { includeArchived: false }, page: { limit: 200 } },
    { includeBackground: false, filter: { includeArchived: true }, page: { limit: 200 } },
  ]);
});
