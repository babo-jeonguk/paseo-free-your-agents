import type { Row } from "../shared/model";
import { pendingStop } from "./filter";

export type ControlAction = "schedule" | "now" | "cancel";
export interface ControlInput {
  agentId: string;
  expectedGeneration: string | null;
  expectedStopId: string | null;
  action: ControlAction;
  hours?: number;
}
export interface BulkIssue {
  agentId: string;
  title: string;
  reason: string;
}
export interface BulkResult {
  succeeded: string[];
  failed: BulkIssue[];
  skipped: BulkIssue[];
}

export function controlReason(row: Row, action: ControlAction, supported: boolean): string | null {
  if (row.stop?.state === "stopping") return "A stop is already in progress.";
  // Cancelling an existing policy remains possible when runtime control is unavailable.
  if (action === "cancel") return pendingStop(row) ? null : "No pending stop to cancel.";
  if (!supported) return "Process control is unavailable on this host.";
  if (row.runtime.presence === "absent") return "No process to stop.";
  if (row.runtime.presence !== "running" || row.runtime.generation === null)
    return "Process status is unavailable.";
  const capable = action === "schedule"
    ? row.runtime.schedulable ?? row.runtime.releasable
    : row.runtime.releasable;
  return capable ? null : row.runtime.unavailableReason ?? "Process controls unavailable.";
}

// A batch is a set of independently guarded changes, not a transaction. Keep the
// reviewed generation/stop IDs even if polling replaces the inventory mid-flight.
// Sequential requests avoid flooding the host and isolate per-row failures.
export async function runBulkControl(
  rows: readonly Row[],
  action: ControlAction,
  supported: boolean,
  hours: number | undefined,
  change: (input: ControlInput) => Promise<{ changed: boolean; reason: string | null }>,
  progress: (completed: number) => void = () => {},
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [], skipped: [] };
  for (const [index, row] of rows.entries()) {
    const issue = { agentId: row.runtime.agentId, title: row.runtime.title };
    const reason = controlReason(row, action, supported);
    if (reason) result.skipped.push({ ...issue, reason });
    else {
      try {
        const response = await change({
          agentId: row.runtime.agentId,
          expectedGeneration: row.runtime.generation,
          expectedStopId: row.stop?.id ?? null,
          action,
          ...(action === "schedule" ? { hours } : {}),
        });
        if (response.changed) result.succeeded.push(row.runtime.agentId);
        else result.failed.push({ ...issue, reason: response.reason ?? "Could not update the stop policy." });
      } catch (error) {
        result.failed.push({ ...issue, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    progress(index + 1);
  }
  return result;
}
