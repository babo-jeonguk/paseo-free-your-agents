import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsMaglevWorkaround } from "./host-compatibility";

test("the worker's own Paseo package gates the Maglev workaround, including betas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fya-host-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "server");
  const nested = join(directory, "dist", "server", "plugins");
  await mkdir(nested, { recursive: true });
  const entry = join(nested, "plugin-process.js");
  await writeFile(entry, "");
  // An unrelated package's newer version must never disable the old-host fix.
  await writeFile(join(nested, "package.json"), JSON.stringify({ name: "unrelated", version: "9.0.0" }));
  for (const [version, expected] of [
    ["0.11.0", true], ["0.11.4", true],
    ["0.12.0-beta.1", false], ["0.12.0-beta.2", false],
    ["0.12.0", false], ["0.13.0", false], ["1.0.0", false],
    ["unknown", true], [null, true],
  ] as const) {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@getpaseo/server", version }));
    assert.equal(needsMaglevWorkaround(entry), expected, String(version));
  }
  await writeFile(join(directory, "package.json"), "invalid json");
  assert.equal(needsMaglevWorkaround(entry), true);
  assert.equal(needsMaglevWorkaround(join(root, "missing.js")), true);
  assert.equal(needsMaglevWorkaround(""), true);
});
