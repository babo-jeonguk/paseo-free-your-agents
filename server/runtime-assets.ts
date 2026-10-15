import { constants } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { runtimeAssets } from "./runtime-assets.generated";
import { assertPrivateDirectory } from "./proxy-control";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
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
  const id = hash(runtimeAssets.version + contents),
    profile = join(profiles, id + ".json"),
    launcher = join(profiles, id + ".launch");
  await immutable(profile, contents, 0o600);
  // Only fixed installation paths enter this tiny exec shim. User CLI argv is
  // data in a private JSON file and is spawned without shell interpretation.
  await immutable(
    launcher,
    "#!/bin/sh\nexec " +
      [process.execPath, "--expose-gc", join(assets, "launcher.mjs"), profile]
        .map(quote)
        .join(" ") +
      ' "$@"\n',
    0o700,
  );
  return [launcher];
}
