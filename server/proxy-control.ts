import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { isControlPipe, ownerOnly, windows } from "./platform.mjs";

// A local capability, never a daemon/client RPC payload. Only the proxy that
// owns this endpoint decides whether its own native child may be released.
export interface ProxyConnection {
  socketPath: string;
  token: string;
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || !ownerOnly(value, 0o700)) {
    throw new Error("Free Your Agents needs an owner-only directory.");
  }
}

export async function proxyRequest(
  connection: ProxyConnection,
  request: {
    id: string;
    op: "snapshot" | "release";
    expectedGeneration?: string;
  },
  timeoutMs = 10_000,
): Promise<unknown> {
  if (windows) {
    // Named pipes have no directory or mode; only accept our own pipe names.
    if (!isControlPipe(connection.socketPath))
      throw new Error("Free Your Agents endpoint ownership is invalid.");
  } else {
    await assertPrivateDirectory(dirname(connection.socketPath));
    const endpoint = await lstat(connection.socketPath);
    if (
      !endpoint.isSocket() ||
      endpoint.isSymbolicLink() ||
      endpoint.uid !== process.getuid?.() ||
      (endpoint.mode & 0o777) !== 0o600
    ) {
      throw new Error("Free Your Agents endpoint ownership is invalid.");
    }
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection.socketPath);
    let bytes = 0,
      buffer = "",
      settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("Free Your Agents request timed out.")),
      timeoutMs,
    );
    socket.on("error", () => finish(new Error("Free Your Agents endpoint is unavailable.")));
    socket.on("close", () =>
      finish(new Error("Free Your Agents connection closed before its result.")),
    );
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...request, token: connection.token }) + "\n"),
    );
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        finish(new Error("Free Your Agents response is too large."));
        return;
      }
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (!response || typeof response !== "object") throw new Error("Invalid proxy response.");
        if ("error" in response) throw new Error("Free Your Agents proxy rejected the request.");
        if (!("id" in response) || response.id !== request.id || !("result" in response)) {
          throw new Error("Free Your Agents response identity mismatch.");
        }
        finish(null, response.result);
      } catch {
        // Never include raw wire data or capabilities in loggable exceptions.
        finish(new Error("Free Your Agents received an invalid proxy response."));
      }
    });
  });
}
