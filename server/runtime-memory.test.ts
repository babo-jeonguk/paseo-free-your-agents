import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryReclaimer, createMemorySampler } from "./runtime/memory.mjs";

function fixture(changeBirth = false, failure?: string) {
  let identities = 0;
  return {
    async readFile(path: string) {
      if (path.endsWith("/stat"))
        return `1 (native helper) ${Array(19).fill("0").join(" ")} ${changeBirth ? ++identities : 100}`;
      if (path === "/proc/2/status")
        throw Object.assign(new Error("Exited helper"), { code: "ENOENT" });
      if (failure)
        throw Object.assign(new Error("Cannot observe"), { code: failure });
      if (path.endsWith("/status"))
        return `Uid:\t${process.getuid!()}\nVmRSS:\t100\n`;
      if (path.endsWith("/smaps_rollup")) return "Pss: 80\n";
      if (path.endsWith("/children")) return "2";
      throw new Error(path);
    },
    async readdir() {
      return ["1"];
    },
  };
}
// /proc observation is Linux-only.
const linux = { skip: process.platform !== "linux" };
test("memory observation tolerates a helper exiting during tree traversal", linux, async () => {
  assert.deepEqual(await createMemorySampler(fixture(), false)(1), {
    nativeMemoryBytes: 80 * 1024,
    nativeMemoryKind: "pss",
  });
});
test("memory observation preserves unknown on access failure or root replacement", linux, async () => {
  for (const io of [fixture(false, "EACCES"), fixture(true)]) {
    assert.equal((await createMemorySampler(io, false)(1)).nativeMemoryBytes, null);
  }
});
test("released runtimes have zero memory without consulting proc", async () => {
  assert.deepEqual(await createMemorySampler(fixture(false, "EACCES"))(), {
    nativeMemoryBytes: 0,
    nativeMemoryKind: "pss",
  });
});
test("a Windows bridge leaves native memory to the plugin's process table", async () => {
  assert.equal((await createMemorySampler(fixture(), true)(1)).nativeMemoryBytes, null);
  assert.equal((await createMemorySampler(fixture(), true)()).nativeMemoryBytes, 0);
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const immediate = () => new Promise((resolve) => setImmediate(resolve));
test("traffic is reclaimed once, after the protocol has been quiet", async () => {
  const calls: unknown[] = [];
  const reclaimer = createMemoryReclaimer({
    gc: (options) => calls.push(options),
    quietMs: 100,
    minBytes: 100,
  });
  reclaimer.note(Buffer.alloc(60));
  await settle(150);
  assert.equal(calls.length, 0, "Light traffic never collects");
  reclaimer.note(Buffer.alloc(60));
  for (let i = 0; i < 4; i++) {
    await settle(10);
    reclaimer.note("x");
  }
  assert.equal(calls.length, 0, "Ongoing traffic postpones collection");
  await settle(150);
  assert.deepEqual(calls, [{ type: "major", execution: "sync", flavor: "last-resort" }]);
  reclaimer.note("x");
  await settle(150);
  assert.equal(calls.length, 1, "Each collection starts a new traffic budget");
});
test("a stop is reclaimed only while the runtime is still released", async () => {
  let collections = 0,
    released = true;
  const reclaimer = createMemoryReclaimer({ gc: () => collections++, quietMs: 20, minBytes: 1 });
  reclaimer.note("history read before the stop");
  reclaimer.released(() => released);
  await immediate();
  assert.equal(collections, 1);
  await settle(50);
  assert.equal(collections, 1, "The stop's collection replaces the pending one");
  reclaimer.released(() => released);
  released = false;
  await immediate();
  assert.equal(collections, 1, "A resumed turn is never collected");
  createMemoryReclaimer({ gc: undefined }).released(() => true);
});
