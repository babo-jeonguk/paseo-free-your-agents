import { evaluateReleaseEvidence } from "./release-evidence.mjs";

// Provider adapters translate their wire messages at this seam. The session
// owns admission and proof epochs so a parsed client frame cannot sit invisibly
// behind a release inspection. Provider output is observation, not admission;
// adapters explicitly invalidate only when an observation changes live release
// evidence.
export function createControlledSession({
  isPassiveClientFrame = () => false,
} = {}) {
  let admissions = 0;
  let epoch = 0;
  let incarnation = 0;

  function exchange(direction, frame) {
    if (direction !== "client" && direction !== "provider")
      throw new Error("Unknown session exchange direction");
    const accepted = direction === "client" || frame?.incarnation === incarnation;
    const fencesRelease = direction === "client" && !isPassiveClientFrame(frame);
    if (fencesRelease) {
      admissions++;
      epoch++;
    }
    let settled = false;
    let invalidated = false;
    return Object.freeze({
      accepted,
      incarnation,
      invalidate() {
        if (invalidated || !accepted || direction !== "provider") return;
        invalidated = true;
        epoch++;
      },
      settle() {
        if (settled) return;
        settled = true;
        if (fencesRelease) admissions--;
      },
    });
  }

  function control(command) {
    if (command.op === "checkpoint") return Object.freeze({ epoch, incarnation });
    if (command.op === "replace") {
      incarnation++;
      epoch++;
      return incarnation;
    }
    if (command.op === "release") {
      const current =
        command.checkpoint?.epoch === epoch &&
        command.checkpoint?.incarnation === incarnation;
      return evaluateReleaseEvidence({
        ...command.evidence,
        pendingWork: command.evidence.pendingWork + admissions,
        stable: command.evidence.stable && current,
      });
    }
    if (command.op === "snapshot") return { admissions, epoch, incarnation };
    throw new Error("Unknown session control operation");
  }

  return Object.freeze({ exchange, control });
}
