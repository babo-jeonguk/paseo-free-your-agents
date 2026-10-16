import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareRuntimeCommand, recordRuntime } from "./runtime-assets";

const windows = process.platform === "win32";
const posix = { skip: windows };

test("materialized launcher keeps original argv, delegates version/history, and strips private capabilities", posix, async (t) => {
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

test("launcher starts an Electron daemon runtime as Node and survives a moved runtime", posix, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-assets-electron-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "native.mjs");
  await writeFile(
    peer,
    `process.stdout.write(JSON.stringify({electron:process.env.ELECTRON_RUN_AS_NODE ?? null,runtime:process.env.FIXTURE_RUNTIME ?? null}));`,
  );
  // Like the desktop binary: without ELECTRON_RUN_AS_NODE it would open the app.
  async function fakeElectron(name: string) {
    const path = join(root, name);
    await writeFile(
      path,
      `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || { echo "desktop app opened" >&2; exit 3; }\nFIXTURE_RUNTIME=${name} exec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    await chmod(path, 0o700);
    return path;
  }
  const mounted = await fakeElectron("mounted");
  const launchers = join(root, "launchers");
  const [launcher] = await prepareRuntimeCommand(
    launchers,
    "codex",
    [process.execPath, peer],
    mounted,
  );
  const run = async (PATH = process.env.PATH) =>
    JSON.parse((await promisify(execFile)(launcher!, ["history"], { env: { PATH } })).stdout);
  assert.deepEqual(await run(), { electron: null, runtime: "mounted" });
  // A relaunched AppImage mounts elsewhere; the plugin records the new runtime.
  await rm(mounted);
  await recordRuntime(launchers, await fakeElectron("remounted"));
  assert.deepEqual(await run(), { electron: null, runtime: "remounted" });
  // Without a recorded runtime, fall back to Node on PATH.
  await rm(join(root, "remounted"));
  assert.deepEqual(await run(), { electron: null, runtime: null });
  await assert.rejects(run(join(root, "empty")), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 127);
    assert.match(error.stderr ?? "", /Node\.js runtime not found/);
    return true;
  });
  assert.equal(dirname(launcher!).startsWith(launchers), true);
});

const peerSource = `if(process.argv.includes("--version"))process.stdout.write("codex 0.162.1\\n");else process.stdout.write(JSON.stringify({argv:process.argv.slice(2),privateRecipe:process.env.RUNTIME_PROXY_RECIPE_FILE ?? null,electron:process.env.ELECTRON_RUN_AS_NODE ?? null,keep:process.env.FIXTURE_KEEP ?? null}));`;
// Like Paseo on Windows: a command script runs through cmd.exe.
const runScript = (script: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  promisify(execFile)(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `""${script}" ${args.join(" ")}"`],
    { env, windowsVerbatimArguments: true },
  );

test("Windows Codex launcher is a command script that keeps original argv data", { skip: !windows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-assets-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "native.mjs"),
    danger = join(root, "must-not-exist");
  await writeFile(peer, peerSource);
  const native = [process.execPath, peer, "a & type nul > " + danger, "100%PATH%", 'q"uote', "x y"];
  const [launcher] = await prepareRuntimeCommand(join(root, "launchers"), "codex", native);
  assert.match(launcher!, /\.cmd$/);
  assert.match((await runScript(launcher!, ["--version"])).stdout, /codex 0.162.1/);
  const result = JSON.parse(
    (
      await runScript(launcher!, ["history"], {
        ...process.env,
        FIXTURE_KEEP: "kept",
        RUNTIME_PROXY_RECIPE_FILE: "not-an-interactive-recipe",
      })
    ).stdout,
  );
  assert.deepEqual(result.argv, [...native.slice(2), "history"]);
  assert.equal(result.keep, "kept");
  assert.equal(result.privateRecipe, null);
  assert.equal(result.electron, null, "The shim's Electron switch never reaches the CLI");
  await assert.rejects(stat(danger), { code: "ENOENT" });
  assert.equal((await readFile(launcher!, "utf8")).includes("type nul"), false);
  assert.deepEqual(await prepareRuntimeCommand(join(root, "launchers"), "codex", native), [launcher]);
  await writeFile(launcher!, "changed by another owner");
  await assert.rejects(prepareRuntimeCommand(join(root, "launchers"), "codex", native), /changed/);
});

test("Windows launcher follows a moved runtime, then Node on PATH", { skip: !windows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-assets-windows-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "native.mjs");
  await writeFile(peer, peerSource);
  const launchers = join(root, "launchers"),
    missing = join(root, "missing 100%", "Paseo.exe");
  const [launcher] = await prepareRuntimeCommand(
    launchers,
    "codex",
    [process.execPath, peer],
    missing,
  );
  const run = async (env: NodeJS.ProcessEnv = process.env) =>
    JSON.parse((await runScript(launcher!, ["history"], env)).stdout);
  // Neither the pointer nor the recorded runtime exists: Node on PATH runs it.
  assert.deepEqual((await run()).argv, ["history"]);
  await recordRuntime(launchers, process.execPath);
  const isolated = { SystemRoot: process.env.SystemRoot, PATH: join(root, "empty") };
  assert.deepEqual((await run(isolated)).argv, ["history"]);
  await recordRuntime(launchers, missing);
  await assert.rejects(run(isolated), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 127);
    assert.match(error.stderr ?? "", /Node\.js runtime not found/);
    return true;
  });
});

test("Windows Claude command is a bare node argv that Paseo starts on its own runtime", { skip: !windows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-assets-windows-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "native.mjs");
  await writeFile(peer, peerSource);
  const command = await prepareRuntimeCommand(join(root, "launchers"), "claude", [
    process.execPath,
    peer,
  ]);
  assert.equal(command[0], "node");
  assert.equal(command[1], "--expose-gc");
  // Paseo replaces a bare `node` with its own runtime and sets Electron's switch.
  const { stdout } = await promisify(execFile)(process.execPath, [...command.slice(1), "history"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.deepEqual(JSON.parse(stdout), {
    argv: ["history"],
    privateRecipe: null,
    electron: null,
    keep: null,
  });
  await assert.rejects(
    prepareRuntimeCommand(join(root, "launchers"), "claude", command),
    /original receipt/,
  );
});
