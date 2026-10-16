// Standalone launch allocation. No SDK, daemon internals, network, or signaling.
// Session hooks issue reusable recipes; each OS proxy launch claims a new lease.
import { constants } from "node:fs";
import { open, lstat, mkdtemp, rm, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { controlSupported, newControlPipe, ownerOnly, ownStart, windows } from "./platform.mjs";

async function privateDirectory(path) {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || !ownerOnly(value, 0o700)) {
    throw new Error("Invalid launch directory ownership");
  }
}

export async function claimProxyConnection(recipeFile, expectedProvider) {
  if (!controlSupported)
    throw new Error("This compatibility launcher is validated on Linux and Windows only");
  await privateDirectory(dirname(recipeFile));
  const file = await open(recipeFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let recipe;
  try {
    const info = await file.stat();
    if (!info.isFile() || !ownerOnly(info, 0o600) || info.size > 8192)
      throw new Error("Invalid launch recipe");
    recipe = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  if (
    recipe.version !== 1 ||
    typeof recipe.recipeId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(recipe.recipeId) ||
    basename(recipeFile) !== recipe.recipeId + ".json" ||
    typeof recipe.agentId !== "string" ||
    !recipe.agentId ||
    recipe.agentId.length > 200 ||
    !["codex", "claude"].includes(recipe.provider) ||
    (expectedProvider !== undefined && recipe.provider !== expectedProvider) ||
    typeof recipe.recordsDirectory !== "string"
  )
    throw new Error("Invalid launch identity");
  // A recipe can write only the adjacent private connection directory, never an
  // arbitrary caller-selected file or remote endpoint.
  const directory = join(dirname(dirname(resolve(recipeFile))), "connections");
  if (recipe.recordsDirectory !== directory) throw new Error("Invalid connection directory");
  await privateDirectory(directory);
  // A Windows named pipe needs no directory; its name is fresh per bridge.
  const socketDirectory = windows ? null : await mkdtemp(join(tmpdir(), "paseo-fya-"));
  const socketPath = socketDirectory ? join(socketDirectory, "control.sock") : newControlPipe();
  try {
    if (Buffer.byteLength(socketPath) > 100) throw new Error("Control socket path is too long");
    const connectionId = randomUUID();
    const proxyStart = await ownStart();
    if (!/^\d+$/.test(proxyStart ?? "")) throw new Error("Process birth identity is unavailable");
    const record = {
      version: 1,
      connectionId,
      agentId: recipe.agentId,
      provider: recipe.provider,
      socketPath,
      token: randomBytes(32).toString("hex"),
      createdAt: Date.now(),
      proxyPid: process.pid,
      proxyStart,
    };
    const connectionFile = join(directory, connectionId + ".json");
    const temporary = join(directory, "." + connectionId + ".tmp");
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await output.writeFile(JSON.stringify(record) + "\n");
    } finally {
      await output.close();
    }
    await rename(temporary, connectionFile);
    return {
      RUNTIME_PROXY_SOCKET: socketPath,
      RUNTIME_PROXY_TOKEN: record.token,
      RUNTIME_PROXY_CONNECTION_ID: connectionId,
      RUNTIME_PROXY_AGENT_ID: recipe.agentId,
      RUNTIME_PROXY_CONNECTION_FILE: connectionFile,
    };
  } catch (error) {
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
}
