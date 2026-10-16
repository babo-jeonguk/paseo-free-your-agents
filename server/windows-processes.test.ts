import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProcessTable,
  nativeWorkingSet,
  parseProcessTable,
  sameStart,
} from "./windows-processes";

const filetime = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
const base = Date.UTC(2026, 9, 16);

test("the CIM table parses FILETIME creation and skips unreadable lines", () => {
  const table = parseProcessTable(
    [`10 4 ${filetime(base)} 4096`, "", "garbage", `11 10 ${filetime(base + 5)} 8192`].join(
      "\r\n",
    ),
  );
  assert.deepEqual([...table.keys()], [10, 11]);
  assert.deepEqual(table.get(11), { pid: 11, parent: 10, created: base + 5, workingSet: 8192 });
});

test("bridge identity tolerates Node startup but rejects a reused PID", () => {
  assert.ok(sameStart(String(base + 300), base));
  assert.ok(sameStart(String(base - 1_000), base));
  assert.ok(!sameStart(String(base + 600_000), base));
  assert.ok(!sameStart(String(base - 60_000), base));
});

test("native memory descends only from the bridge's own child", () => {
  const bridge = { pid: 10, start: String(base + 50) };
  const entries = [
    { pid: 10, parent: 4, created: base, workingSet: 1 },
    { pid: 20, parent: 10, created: base + 100, workingSet: 300 },
    { pid: 21, parent: 20, created: base + 200, workingSet: 200 },
    // Its parent PID was reused: created before the native process existed.
    { pid: 22, parent: 20, created: base - 10, workingSet: 999 },
    { pid: 30, parent: 4, created: base + 100, workingSet: 777 },
  ];
  const table = new Map(entries.map((entry) => [entry.pid, entry]));
  assert.equal(nativeWorkingSet(table, 20, bridge), 500);
  assert.equal(nativeWorkingSet(table, 30, bridge), null, "Not the bridge's child");
  assert.equal(nativeWorkingSet(table, 99, bridge), null, "Exited");
  assert.equal(
    nativeWorkingSet(table, 20, { pid: 10, start: String(base + 600_000) }),
    null,
    "Bridge PID was reused",
  );
});

test("the table is shared within its lifetime and refreshed for newer records", async () => {
  let queries = 0;
  let release: () => void = () => {};
  const table = createProcessTable(async () => {
    queries++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return `10 4 ${filetime(base)} 4096`;
  }, 60_000);
  const first = table(),
    second = table();
  release();
  assert.equal(await first, await second);
  assert.equal(queries, 1);
  const captured = (await first).capturedAt;
  assert.equal(await table(captured), await first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = table(captured + 1);
  release();
  assert.ok((await newer).capturedAt > captured);
  assert.equal(queries, 2);
});

test("a failed query is not cached", async () => {
  let fail = true;
  const table = createProcessTable(async () => {
    if (fail) throw new Error("PowerShell unavailable");
    return "";
  });
  await assert.rejects(table(), /unavailable/);
  fail = false;
  assert.equal((await table()).processes.size, 0);
});
