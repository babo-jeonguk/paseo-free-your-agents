import { constants } from "node:fs";
import { mkdir, open, link, unlink, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { runtimeAssets } from "./runtime-assets.generated";
import { assertPrivateDirectory } from "./proxy-control";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// Bump when the launcher shim text changes, so new shims get new immutable paths.
const SHIM_VERSION = "2";

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
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== mode ||
      info.size !== Buffer.byteLength(contents) ||
      hash(await existing.readFile("utf8")) !== hash(contents)
    )
      throw new Error("Runtime assets were changed; preserving them instead of overwriting.");
  } finally {
    await existing.close();
  }
}
export async function prepareRuntimeCommand(
  directory: string,
  provider: "codex" | "claude",
  originalCommand: string[] | null,
  runtime = process.execPath,
) {
  directory = resolve(directory);
  const command = originalCommand ?? [provider];
  if (command[0]!.startsWith(directory + "/"))
    throw new Error("Cannot adopt a Runtime Control command without its original receipt.");
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
    profile = join(profiles, id + ".json"),
    launcher = join(profiles, id + ".launch");
  await immutable(profile, contents, 0o600);
  await recordRuntime(directory, runtime);
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
      "  echo 'Runtime Control: Node.js runtime not found. Restore this provider command in Runtime Control.' >&2",
      "  exit 127",
      "}",
      'ELECTRON_RUN_AS_NODE=1 exec "$runtime" ' +
        ["--expose-gc", join(assets, "launcher.mjs"), profile].map(quote).join(" ") +
        ' "$@"',
      "",
    ].join("\n"),
    0o700,
  );
  return [launcher];
}
