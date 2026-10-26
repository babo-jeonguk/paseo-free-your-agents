export interface ReleaseEvidence {
  protocolSupported: boolean;
  trackingComplete: boolean;
  inventoryComplete: boolean;
  pendingWork: number;
  subjects: Array<{
    execution: "unknown" | "settled" | "active";
    goal: "unknown" | "complete" | "unfinished";
    background: "unknown" | "none" | "present";
    scheduled: "unknown" | "none" | "present";
  }>;
  resumeDurable: boolean;
  stable: boolean;
}

export type ReleaseEvidenceResult =
  | { status: "safe" }
  | { status: "busy" | "unsupported"; reason: string };

export function evaluateReleaseEvidence(evidence: ReleaseEvidence): ReleaseEvidenceResult;
