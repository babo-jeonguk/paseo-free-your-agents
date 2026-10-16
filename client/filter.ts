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
export interface Total {
  value: string;
  caption: string | null;
  accessibilityLabel: string;
}
const MIB = 1024 * 1024;
// Card totals switch to GB so large sums still fit a narrow card.
function totalSize(bytes: number) {
  return bytes >= 10 * 1024 * MIB
    ? { short: `${(bytes / 1024 / MIB).toFixed(1)}`, unit: "GB", spoken: "gigabytes" }
    : { short: Math.round(bytes / MIB).toLocaleString(), unit: "MB", spoken: "megabytes" };
}
// Sum what was measured and mark it as a lower bound when some rows were not,
// in the "99+" form of design-system badges. Symbols stay out of spoken labels.
export function memoryTotal(rows: Row[]): Total {
  const missing = rows.filter((row) => row.runtime.memoryBytes === null).length;
  const bytes = rows.reduce((total, row) => total + (row.runtime.memoryBytes ?? 0), 0);
  const caption = missing ? `${missing} not measured` : null;
  const note = missing ? ` ${missing} ${missing === 1 ? "conversation" : "conversations"} not measured.` : "";
  if (missing && bytes === 0)
    return { value: "Not measured", caption, accessibilityLabel: `Process memory: not measured.${note}` };
  const size = totalSize(bytes);
  return {
    value: `${size.short}${missing ? "+" : ""}\u00a0${size.unit}`,
    caption,
    accessibilityLabel: `Process memory: ${missing ? "at least " : ""}${size.short} ${size.spoken}.${note}`,
  };
}
export function processTotal(rows: Row[]): Total {
  const unknown = rows.filter((row) => row.runtime.presence === "unknown").length;
  const running = rows.filter((row) => row.runtime.presence === "running").length;
  const caption = unknown ? `${unknown} unknown` : null;
  const note = unknown ? ` ${unknown} ${unknown === 1 ? "conversation" : "conversations"} unknown.` : "";
  if (unknown && running === 0)
    return { value: "Unknown", caption, accessibilityLabel: `Processes: unknown.${note}` };
  return {
    value: `${running}${unknown ? "+" : ""}`,
    caption,
    accessibilityLabel: `Processes: ${unknown ? "at least " : ""}${running} running.${note}`,
  };
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
