import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareRuntimeCommand } from "./runtime-assets";

test("materialized launcher keeps original argv, delegates version/history, and strips private capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-assets-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "native.mjs"),
    danger = join(root, "must-not-exist");
  await writeFile(
    peer,
    `if(process.argv.includes("--version"))process.stdout.write("codex 0.162.1\\n");else process.stdout.write(JSON.stringify({argv:process.argv.slice(2),privateRecipe:process.env.RUNTIME_PROXY_RECIPE_FILE ?? null,keep:process.env.FIXTURE_KEEP}));`,
  );
  const native = [process.execPath, peer, "literal $(touch " + danger + ")", "semi;colon"];
  const [launcher] = await prepareRuntimeCommand(join(root, "assets"), "codex", native);
  assert.equal((await stat(launcher!)).mode & 0o777, 0o700);
  const execute = promisify(execFile);
  assert.match((await execute(launcher!, ["--version"])).stdout, /codex 0.162.1/);
  const result = JSON.parse(
    (
      await execute(launcher!, ["history"], {
        env: {
          PATH: process.env.PATH,
          FIXTURE_KEEP: "kept",
          RUNTIME_PROXY_RECIPE_FILE: "not-an-interactive-recipe",
        },
      })
    ).stdout,
  );
  assert.deepEqual(result.argv, [...native.slice(2), "history"]);
  assert.equal(result.keep, "kept");
  assert.equal(result.privateRecipe, null);
  await assert.rejects(stat(danger), { code: "ENOENT" });
  assert.equal(
    (await readFile(launcher!, "utf8")).includes("touch"),
    false,
    "Original argv stays data, outside executable shell text",
  );
  assert.deepEqual(await prepareRuntimeCommand(join(root, "assets"), "codex", native), [launcher]);
  await writeFile(launcher!, "changed by another owner");
  await assert.rejects(prepareRuntimeCommand(join(root, "assets"), "codex", native), /changed/);
  assert.equal(await readFile(launcher!, "utf8"), "changed by another owner");
});
