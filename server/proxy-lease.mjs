// Standalone ownership verification/cleanup for a launched CLI facade. No SDK,
// daemon state, PID discovery, recursive deletion, or process signaling.
import { constants } from "node:fs";
import { open, lstat, unlink, rmdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function ownProxyLease(provider, env = process.env) {
  const path = env.RUNTIME_PROXY_CONNECTION_FILE;
  if (!path) return async () => {};
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700
  )
    throw new Error("Invalid connection record directory");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let identity, contents;
  try {
    identity = await file.stat();
    if (
      !identity.isFile() ||
      identity.uid !== process.getuid() ||
      (identity.mode & 0o777) !== 0o600 ||
      identity.size > 8192
    )
      throw new Error("Invalid connection record");
    contents = await file.readFile("utf8");
    const record = JSON.parse(contents);
    if (
      record.version !== 1 ||
      record.provider !== provider ||
      typeof record.connectionId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.connectionId) ||
      typeof record.agentId !== "string" ||
      !record.agentId ||
      record.agentId.length > 200 ||
      typeof record.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.token) ||
      record.connectionId !== env.RUNTIME_PROXY_CONNECTION_ID ||
      record.agentId !== env.RUNTIME_PROXY_AGENT_ID ||
      record.socketPath !== env.RUNTIME_PROXY_SOCKET ||
      record.token !== env.RUNTIME_PROXY_TOKEN ||
      basename(path) !== record.connectionId + ".json"
    )
      throw new Error("Connection identity mismatch");
  } finally {
    await file.close();
  }
  const socketDirectory = dirname(env.RUNTIME_PROXY_SOCKET);
  const directory = await lstat(socketDirectory);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700 ||
    !basename(socketDirectory).startsWith("paseo-rc-")
  )
    throw new Error("Invalid connection endpoint directory");
  let finished = false;
  return async () => {
    if (finished) return;
    // Never remove a record or directory replaced since this facade claimed it.
    const current = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current && (current.ino !== identity.ino || current.dev !== identity.dev))
      throw new Error("Connection record was replaced; preserving it");
    if (current) {
      const reopened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await reopened.stat();
        if (
          info.ino !== identity.ino ||
          info.dev !== identity.dev ||
          info.size > 8192 ||
          (await reopened.readFile("utf8")) !== contents
        )
          throw new Error("Connection record changed; preserving it");
      } finally {
        await reopened.close();
      }
      await unlink(path);
    }
    const endpoint = await lstat(socketDirectory).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (endpoint && endpoint.ino === directory.ino && endpoint.dev === directory.dev)
      await rmdir(socketDirectory).catch((error) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
      });
    finished = true;
  };
}
