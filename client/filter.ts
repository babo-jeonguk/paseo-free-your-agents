import type { Row } from "../shared/model";

export const filters = [
  {
    id: "idle",
    label: "Idle",
    description: "A process is running with no active work. Its memory can be freed.",
  },
  {
    id: "working",
    label: "Working",
    description: "A process is running and working, including background work.",
  },
  {
    id: "absent",
    label: "No process",
    description: "The process is confirmed absent. The conversation tab remains open.",
  },
  {
    id: "unknown",
    label: "Unknown",
    description: "Process presence or work status is unavailable.",
  },
] as const;
export type Filter = (typeof filters)[number]["id"];
export function category(row: Row): Filter {
  // Classify by process facts only; stop state is shown under Process control.
  // Confirmed absence takes precedence over a stale activity value.
  if (row.runtime.presence === "absent") return "absent";
  if (row.runtime.presence === "unknown") return "unknown";
  if (row.runtime.activity === "idle") return "idle";
  if (row.runtime.activity === "working" || row.runtime.activity === "background")
    return "working";
  return "unknown";
}
export function matches(row: Row, filter: Filter): boolean {
  return category(row) === filter;
}
export function pendingStop(row: Row): boolean {
  return row.stop !== null && row.stop.state !== "failed" && row.runtime.presence !== "absent";
}
export function visible(rows: Row[], selected: Filter[], query: string): Row[] {
  const term = query.trim().toLowerCase();
  return rows.filter((row) => {
    const text =
      `${row.runtime.title} ${row.runtime.workspace} ${row.runtime.provider}`.toLowerCase();
    return (
      text.includes(term) &&
      (selected.length === 0 || selected.some((filter) => matches(row, filter)))
    );
  });
}
export function memoryLabel(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes === 0) return "—";
  return `${Math.round(bytes / 1024 / 1024).toLocaleString()} MB`;
}
export function providerLabel(provider: string): string {
  const labels: Record<string, string> = { codex: "Codex", claude: "Claude" };
  return labels[provider] ?? provider;
}
export function statusLabel(row: Row): string {
  if (row.runtime.presence === "absent")
    return row.stopped ? "Process stopped" : "No process";
  if (row.runtime.presence === "unknown") return "Status unavailable";
  if (row.runtime.activity === "working") return "Working";
  if (row.runtime.activity === "background") return "Background work";
  if (row.runtime.activity === "unknown") return "Status unavailable";
  return "Idle";
}
export function controlNote(row: Row): string | null {
  if (row.runtime.controlStatus === "after-restart") return "Applies after restart";
  return null;
}
