import { execFile } from "node:child_process";
import { join } from "node:path";

export interface WindowsProcess {
  pid: number;
  parent: number;
  // Creation time in epoch milliseconds.
  created: number;
  workingSet: number;
}
export interface ProcessTable {
  // When the query started: every process alive then and still alive is listed.
  capturedAt: number;
  processes: Map<number, WindowsProcess>;
}

// One CIM query lists every process with its parent, creation time and working
// set. Bridges report only their native PID, so the plugin reads one table per
// refresh for all of them instead of starting PowerShell in every bridge.
const script =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,WorkingSetSize" +
  " | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2} {3}' -f $_.ProcessId," +
  "$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc(),$_.WorkingSetSize } }";

export function parseProcessTable(text: string): Map<number, WindowsProcess> {
  const processes = new Map<number, WindowsProcess>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+) (\d+)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      parent: Number(match[2]),
      // FILETIME counts 100 ns intervals since 1601.
      created: Number(BigInt(match[3]!) / 10_000n - 11_644_473_600_000n),
      workingSet: Number(match[4]),
    });
  }
  return processes;
}

function queryProcesses(): Promise<string> {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return new Promise((resolve, reject) =>
    execFile(
      join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

// Cached and coalesced. A caller that must not see processes from before some
// moment passes it, and gets a table whose query started no earlier.
export function createProcessTable(query = queryProcesses, ttlMs = 10_000) {
  let current: ProcessTable | null = null,
    pending: { startedAt: number; table: Promise<ProcessTable> } | null = null;
  return (notBefore = 0): Promise<ProcessTable> => {
    const now = Date.now();
    if (current && current.capturedAt >= notBefore && now - current.capturedAt < ttlMs)
      return Promise.resolve(current);
    if (pending && pending.startedAt >= notBefore) return pending.table;
    const startedAt = now;
    const table = query().then((text) => {
      const value = { capturedAt: startedAt, processes: parseProcessTable(text) };
      if (!current || current.capturedAt <= startedAt) current = value;
      return value;
    });
    const settle = () => {
      if (pending?.table === table) pending = null;
    };
    table.then(settle, settle);
    pending = { startedAt, table };
    return table;
  };
}

// A bridge records Node's start, which follows process creation by the time an
// Electron or busy host takes to boot Node.
export function sameStart(start: string, created: number) {
  const value = Number(start);
  return value >= created - 2_000 && value <= created + 120_000;
}

// Working set of the native tree a bridge spawned. The root must be the
// bridge's child, and a parent PID alone can be stale after reuse, so every
// descendant must also be created after its parent.
export function nativeWorkingSet(
  table: Map<number, WindowsProcess>,
  nativePid: number,
  bridge: { pid: number; start: string },
): number | null {
  const owner = table.get(bridge.pid),
    root = table.get(nativePid);
  if (
    !owner ||
    !root ||
    !sameStart(bridge.start, owner.created) ||
    root.parent !== owner.pid ||
    root.created < owner.created
  )
    return null;
  const children = new Map<number, WindowsProcess[]>();
  for (const entry of table.values()) {
    const siblings = children.get(entry.parent);
    if (siblings) siblings.push(entry);
    else children.set(entry.parent, [entry]);
  }
  const queue = [root],
    seen = new Set<number>();
  let total = 0;
  while (queue.length) {
    const entry = queue.shift()!;
    if (seen.has(entry.pid)) continue;
    if (seen.size >= 256) return null;
    seen.add(entry.pid);
    total += entry.workingSet;
    for (const child of children.get(entry.pid) ?? [])
      if (child.created >= entry.created) queue.push(child);
  }
  return total;
}
