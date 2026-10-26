import type { ReleaseEvidence, ReleaseEvidenceResult } from "./release-evidence.mjs";

export interface SessionCheckpoint {
  readonly epoch: number;
  readonly incarnation: number;
}

export interface SessionExchange {
  readonly accepted: boolean;
  readonly incarnation: number;
  settle(): void;
}

export interface ControlledSession<Frame = unknown> {
  exchange(direction: "client" | "provider", frame: Frame): SessionExchange;
  control(command: { op: "checkpoint" }): SessionCheckpoint;
  control(command: { op: "replace" }): number;
  control(command: {
    op: "release";
    checkpoint: SessionCheckpoint;
    evidence: ReleaseEvidence;
  }): ReleaseEvidenceResult;
  control(command: { op: "snapshot" }): {
    admissions: number;
    epoch: number;
    incarnation: number;
  };
}

export function createControlledSession<Frame = unknown>(options?: {
  isPassiveClientFrame?: (frame: Frame) => boolean;
  isActivityProviderFrame?: (frame: Frame) => boolean;
}): ControlledSession<Frame>;
