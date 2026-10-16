import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nativeCommand, processExists, resolveWindowsCommand, signalNative } from "./platform.mjs";

const windowsOnly = { skip: process.platform !== "win32" };

// An npm-style shim: cmd.exe parses the forwarded arguments a second time.
async function npmShim(root: string) {
  const script = join(root, "print.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const bin = join(root, "bin dir");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  await writeFile(
    join(bin, "fixture.cmd"),
    `@"${process.execPath}" "${script}" %*\r\n`,
  );
  return bin;
}

test("Windows resolves bare CLI names through PATH and PATHEXT", windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "platform-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = await npmShim(root);
  const env = { Path: `"${bin}";${process.env.PATH}`, PATHEXT: ".EXE;.CMD" };
  assert.equal(resolveWindowsCommand("fixture", env).toLowerCase(), join(bin, "fixture.cmd").toLowerCase());
  assert.equal(resolveWindowsCommand(join(bin, "fixture"), env).toLowerCase(), join(bin, "fixture.cmd").toLowerCase());
  assert.equal(resolveWindowsCommand("missing-runtime-control-cli", env), "missing-runtime-control-cli");
});

test("Windows command scripts receive every argument exactly once", windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "platform-quote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = await npmShim(root);
  const danger = join(root, "must-not-exist");
  const args = [
    "app-server",
    "x y",
    'q"uote',
    "a & type nul > " + danger,
    "100%PATH%",
    "^caret",
    "(paren)",
    "!bang!",
    "<in>|out",
    "trailing\\",
    '{"json":"value with space"}',
    "",
  ];
  // Like a bridge's environment: one PATH entry, whatever its case.
  const env = Object.fromEntries(
    Object.entries(process.env).map(([name, value]) =>
      name.toUpperCase() === "PATH" ? [name, `${bin};${value}`] : [name, value],
    ),
  );
  const native = nativeCommand("fixture", args, env);
  const { stdout } = await promisify(execFile)(native.file, native.args, { ...native.options, env });
  assert.deepEqual(JSON.parse(stdout), args);
  await assert.rejects(readFile(danger), { code: "ENOENT" });
});

test("Windows stops the whole native tree the bridge spawned", windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "platform-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grandchild = join(root, "grandchild.txt");
  const script = join(root, "tree.mjs");
  await writeFile(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(grandchild)}, String(child.pid));
setInterval(() => {}, 1000);`,
  );
  const native = nativeCommand(process.execPath, [script]);
  const child = spawn(native.file, native.args, { ...native.options, stdio: "ignore" });
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    pid = Number(await readFile(grandchild, "utf8").catch(() => "0"));
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(processExists(pid));
  const exited = once(child, "exit");
  signalNative(child, "SIGTERM");
  await exited;
  for (let attempt = 0; attempt < 100 && processExists(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(processExists(pid), false, "The native CLI's own helper is stopped too");
});
