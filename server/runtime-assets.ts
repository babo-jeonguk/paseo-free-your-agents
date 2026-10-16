import { constants } from "node:fs";
import { mkdir, open, link, unlink, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { runtimeAssets } from "./runtime-assets.generated";
import { assertPrivateDirectory } from "./proxy-control";
import { ownerOnly, resolveWindowsCommand, windows } from "./platform.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// Bump when the launcher shim text changes, so new shims get new immutable paths.
const SHIM_VERSION = "3";
// The bridge collects its own garbage (runtime/memory.mjs). A 1 MB young
// generation keeps a mostly idle proxy from holding the much larger one V8
// grows during a burst of protocol traffic.
const BRIDGE_FLAGS = ["--expose-gc", "--max-semi-space-size=1"];
// The launcher build prepareRuntimeCommand points at. A provider command made by
// an older build is moved to this one after an update.
export const launcherBuild = runtimeAssets.version + "." + SHIM_VERSION;

// A desktop AppImage mounts the daemon's runtime at a new path on every launch.
// Launchers read this pointer first, so the plugin refreshes it whenever it runs.
export async function recordRuntime(directory: string, runtime = process.execPath) {
  directory = resolve(directory);
  const path = join(directory, "runtime"),
    contents = runtime + "\n";
  if ((await readFile(path, "utf8").catch(() => null)) === contents) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function immutable(path: string, contents: string, mode: number) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await existing.stat();
    if (
      !info.isFile() ||
      !ownerOnly(info, mode) ||
      info.size !== Buffer.byteLength(contents) ||
      hash(await existing.readFile("utf8")) !== hash(contents)
    )
      throw new Error("Runtime assets were changed; preserving them instead of overwriting.");
  } finally {
    await existing.close();
  }
}
// The Windows counterpart of the exec shim below, for Codex, which Paseo runs
// through cmd.exe. Fixed installation paths only; `%` is the one character a
// quoted batch path must escape.
function windowsShim(directory: string, runtime: string, bridge: string[]) {
  const quoted = (value: string) => '"' + value.replaceAll("%", "%%") + '"';
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "runtime="',
    `if exist ${quoted(join(directory, "runtime"))} set /p runtime=<${quoted(join(directory, "runtime"))}`,
    'if defined runtime if not exist "%runtime%" set "runtime="',
    `if not defined runtime if exist ${quoted(runtime)} set "runtime=${runtime.replaceAll("%", "%%")}"`,
    'if not defined runtime for %%I in (node.exe) do set "runtime=%%~$PATH:I"',
    "if not defined runtime (",
    "  echo Free Your Agents: Node.js runtime not found. Restore this provider command in Free Your Agents. 1>&2",
    "  exit /b 127",
    ")",
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%runtime%" ' + bridge.map(quoted).join(" ") + " %*",
    "",
  ].join("\r\n");
}
export async function prepareRuntimeCommand(
  directory: string,
  provider: "codex" | "claude",
  originalCommand: string[] | null,
  runtime = process.execPath,
) {
  directory = resolve(directory);
  const command = originalCommand ?? [provider];
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  if (command.some((arg) => fold(arg).startsWith(fold(directory + sep))))
    throw new Error("Cannot adopt a Free Your Agents command without its original receipt.");
  // Paseo starts Claude without a shell, which cannot run a command script on
  // Windows. A bare `node` command makes Paseo start the bridge on its own
  // runtime instead; version probes still find Node on PATH.
  if (windows && provider === "claude" && !/\.exe$/i.test(resolveWindowsCommand("node")))
    throw new Error("Claude process control on Windows needs Node.js on PATH.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
  const assets = join(directory, runtimeAssets.version),
    profiles = join(directory, "profiles");
  for (const child of [assets, profiles]) {
    await mkdir(child, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(child);
  }
  if (hash(JSON.stringify(runtimeAssets.files)) !== runtimeAssets.version)
    throw new Error("Invalid bundled runtime assets");
  for (const [name, contents] of Object.entries(runtimeAssets.files))
    await immutable(join(assets, name), contents, 0o600);
  const contents = JSON.stringify({ version: 1, provider, command });
  const id = hash(runtimeAssets.version + SHIM_VERSION + runtime + contents),
    profile = join(profiles, id + ".json");
  await immutable(profile, contents, 0o600);
  await recordRuntime(directory, runtime);
  if (windows) {
    const bridge = [...BRIDGE_FLAGS, join(assets, "launcher.mjs"), profile];
    if (provider === "claude") return ["node", ...bridge];
    const launcher = join(profiles, id + ".cmd");
    await immutable(launcher, windowsShim(directory, runtime, bridge), 0o700);
    return [launcher];
  }
  const launcher = join(profiles, id + ".launch");
  // Only fixed installation paths enter this tiny exec shim. User CLI argv is
  // data in a private JSON file and is spawned without shell interpretation.
  // Paseo strips ELECTRON_RUN_AS_NODE from CLI environments, but a desktop
  // daemon's runtime is Electron; launcher.mjs removes it again for the CLI.
  await immutable(
    launcher,
    [
      "#!/bin/sh",
      "runtime=",
      `IFS= read -r runtime 2>/dev/null < ${quote(join(directory, "runtime"))}`,
      `[ -x "$runtime" ] || runtime=${quote(runtime)}`,
      '[ -x "$runtime" ] || runtime=$(command -v node) || {',
      "  echo 'Free Your Agents: Node.js runtime not found. Restore this provider command in Free Your Agents.' >&2",
      "  exit 127",
      "}",
      'ELECTRON_RUN_AS_NODE=1 exec "$runtime" ' +
        [...BRIDGE_FLAGS, join(assets, "launcher.mjs"), profile].map(quote).join(" ") +
        ' "$@"',
      "",
    ].join("\n"),
    0o700,
  );
  return [launcher];
}
