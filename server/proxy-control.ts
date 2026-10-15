import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

// A local capability, never a daemon/client RPC payload. Only the proxy that
// owns this endpoint decides whether its own native child may be released.
export interface ProxyConnection {
  socketPath: string;
  token: string;
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid?.() ||
    (value.mode & 0o777) !== 0o700
  ) {
    throw new Error("Runtime Control needs an owner-only directory.");
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
  await assertPrivateDirectory(dirname(connection.socketPath));
  const endpoint = await lstat(connection.socketPath);
  if (
    !endpoint.isSocket() ||
    endpoint.isSymbolicLink() ||
    endpoint.uid !== process.getuid?.() ||
    (endpoint.mode & 0o777) !== 0o600
  ) {
    throw new Error("Runtime Control endpoint ownership is invalid.");
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
      () => finish(new Error("Runtime Control request timed out.")),
      timeoutMs,
    );
    socket.on("error", () => finish(new Error("Runtime Control endpoint is unavailable.")));
    socket.on("close", () =>
      finish(new Error("Runtime Control connection closed before its result.")),
    );
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...request, token: connection.token }) + "\n"),
    );
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        finish(new Error("Runtime Control response is too large."));
        return;
      }
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (!response || typeof response !== "object") throw new Error("Invalid proxy response.");
        if ("error" in response) throw new Error("Runtime Control proxy rejected the request.");
        if (!("id" in response) || response.id !== request.id || !("result" in response)) {
          throw new Error("Runtime Control response identity mismatch.");
        }
        finish(null, response.result);
      } catch {
        // Never include raw wire data or capabilities in loggable exceptions.
        finish(new Error("Runtime Control received an invalid proxy response."));
      }
    });
  });
}
