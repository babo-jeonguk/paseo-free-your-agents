import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySampler } from "./runtime/memory.mjs";

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
test("memory observation tolerates a helper exiting during tree traversal", async () => {
  assert.deepEqual(await createMemorySampler(fixture())(1), {
    nativeMemoryBytes: 80 * 1024,
    nativeMemoryKind: "pss",
  });
});
test("memory observation preserves unknown on access failure or root replacement", async () => {
  for (const io of [fixture(false, "EACCES"), fixture(true)]) {
    assert.equal((await createMemorySampler(io)(1)).nativeMemoryBytes, null);
  }
});
test("released runtimes have zero memory without consulting proc", async () => {
  assert.deepEqual(await createMemorySampler(fixture(false, "EACCES"))(), {
    nativeMemoryBytes: 0,
    nativeMemoryKind: "pss",
  });
});
