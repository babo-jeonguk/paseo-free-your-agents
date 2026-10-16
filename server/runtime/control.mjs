// Private local control transport for provider CLI bridges.
// A private Unix socket or Windows named pipe is separate from provider stdio.
// No TCP listener, prompt payloads, arbitrary RPC forwarding, file paths, or
// caller-selected PIDs.
import { createServer, createConnection } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { lstat, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { isControlPipe, windows } from "../platform.mjs";

function authorized(actual, expected) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  const bytes = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}

export async function listenControl({ path, token, handle }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Missing control capability");
  if (windows) {
    if (!isControlPipe(path)) throw new Error("Control endpoint must be a Free Your Agents pipe");
  } else {
    const directory = await lstat(dirname(path));
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid() ||
      (directory.mode & 0o777) !== 0o700
    ) {
      throw new Error("Control directory must be owned by this user with mode 0700");
    }
  }
  // Do not unlink any preexisting path: a conflicting endpoint is a hard error.
  const sockets = new Set();
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = "",
      bytes = 0,
      consumed = false;
    socket.on("data", (chunk) => {
      if (consumed) return;
      bytes += chunk.length;
      if (bytes > 8192) {
        consumed = true;
        socket.destroy();
        return;
      }
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      consumed = true;
      void (async () => {
        try {
          const message = JSON.parse(buffer.slice(0, end));
          if (!authorized(message.token, token)) throw new Error("Unauthorized control request");
          if (
            typeof message.id !== "string" ||
            message.id.length > 128 ||
            !message.id ||
            !["snapshot", "release"].includes(message.op) ||
            (message.op === "release" &&
              (typeof message.expectedGeneration !== "string" ||
                message.expectedGeneration.length > 128))
          ) {
            throw new Error("Invalid control request");
          }
          const result = await handle({
            id: message.id,
            op: message.op,
            expectedGeneration: message.expectedGeneration,
          });
          socket.end(JSON.stringify({ id: message.id, result }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: error.message }) + "\n");
        }
      })();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  if (!windows) await chmod(path, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    // Node removes its own socket path on close. Never delete a replacement.
  };
}

export function callControl(path, token, message) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "",
      bytes = 0;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Control timeout"));
    }, 10_000);
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      reject(new Error("Control connection closed"));
    });
    socket.on("connect", () => socket.write(JSON.stringify({ ...message, token }) + "\n"));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        socket.destroy();
        reject(new Error("Oversized control response"));
        return;
      }
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.error) reject(new Error(response.error));
        else if (response.id !== message.id)
          reject(new Error("Control response identity mismatch"));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
  });
}
