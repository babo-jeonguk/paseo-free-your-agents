import { readFile, readdir } from "node:fs/promises";
import { windows } from "../platform.mjs";

export function reclaimReleasedMemory(isReleased) {
  // Our standalone launcher exposes GC only in the bridge process. Run after
  // the release stack unwinds, and skip if a new message has already resumed.
  if (
    typeof globalThis.gc === "function" &&
    process.memoryUsage().heapUsed > 24 * 1024 * 1024
  )
    setImmediate(() => {
      if (isReleased()) globalThis.gc();
    });
}

// Only descend from the native process we spawned. Read-only, cached, and
// bounded; no unrelated PID inventory or process signaling is involved.
// Windows has no /proc: the plugin server measures every bridge's native tree
// from one process table instead, so a bridge reports its memory as unknown.
export function createMemorySampler(io = { readFile, readdir }, platformWindows = windows) {
  let previous = null;
  return async (pid) => {
    if (!pid) return { nativeMemoryBytes: 0, nativeMemoryKind: "pss" };
    if (platformWindows) return { nativeMemoryBytes: null, nativeMemoryKind: undefined };
    if (
      previous?.pid === pid &&
      Date.now() - previous.at <
        (previous.value.nativeMemoryBytes === null ? 1000 : 10000)
    )
      return previous.value;
    let value = { nativeMemoryBytes: null, nativeMemoryKind: undefined };
    try {
      const birth = (stat) =>
        stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19];
      const started = birth(await io.readFile(`/proc/${pid}/stat`, "utf8"));
      if (!started) throw new Error("Native process identity unavailable");
      const queue = [pid],
        seen = new Set();
      let pss = 0,
        rss = 0,
        pssComplete = true;
      while (queue.length) {
        if (seen.size >= 256)
          throw new Error("Native process inventory exceeds memory budget");
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        let status;
        try {
          status = await io.readFile(`/proc/${current}/status`, "utf8");
        } catch (error) {
          // Short-lived native helpers may exit during read-only observation.
          if (current !== pid && error.code === "ENOENT") continue;
          throw error;
        }
        if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== process.getuid())
          throw new Error("Native memory ownership changed");
        const resident = status.match(/^VmRSS:\s+(\d+)/m);
        if (!resident) {
          if (current !== pid && /^State:\s+Z/m.test(status)) continue;
          throw new Error("Native resident memory unavailable");
        }
        rss += Number(resident[1]) * 1024;
        const rollup = await io
          .readFile(`/proc/${current}/smaps_rollup`, "utf8")
          .catch(() => null);
        const match = rollup?.match(/^Pss:\s+(\d+)/m);
        if (match) pss += Number(match[1]) * 1024;
        else pssComplete = false;
        const tasks = await io
          .readdir(`/proc/${current}/task`)
          .catch((error) => {
            if (current !== pid && error.code === "ENOENT") return [];
            throw error;
          });
        if (tasks.length > 256)
          throw new Error("Native task inventory exceeds memory budget");
        for (const tid of tasks) {
          const children = await io
            .readFile(`/proc/${current}/task/${tid}/children`, "utf8")
            .catch((error) => {
              if (error.code === "ENOENT") return "";
              throw error;
            });
          for (const id of children.trim().split(/\s+/).filter(Boolean))
            if (!seen.has(Number(id))) queue.push(Number(id));
        }
      }
      if (birth(await io.readFile(`/proc/${pid}/stat`, "utf8")) !== started)
        throw new Error("Native process identity changed during observation");
      value = {
        nativeMemoryBytes: pssComplete ? pss : rss,
        nativeMemoryKind: pssComplete ? "pss" : "rss",
      };
    } catch {
      /* Uncertain process trees are unavailable, never fabricated zero. */
    }
    previous = { pid, at: Date.now(), value };
    return value;
  };
}
