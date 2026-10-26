// Provider-neutral release policy. Provider adapters collect facts; this
// module alone decides whether those facts are sufficient to stop a process.
const unsupported = (reason) => ({ status: "unsupported", reason });
const busy = (reason) => ({ status: "busy", reason });
const values = {
  execution: new Set(["unknown", "settled", "active"]),
  goal: new Set(["unknown", "complete", "unfinished"]),
  background: new Set(["unknown", "none", "present"]),
  scheduled: new Set(["unknown", "none", "present"]),
};

export function evaluateReleaseEvidence(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.protocolSupported !== "boolean" ||
    typeof evidence.trackingComplete !== "boolean" ||
    typeof evidence.inventoryComplete !== "boolean" ||
    !Number.isSafeInteger(evidence.pendingWork) ||
    evidence.pendingWork < 0 ||
    !Array.isArray(evidence.subjects) ||
    evidence.subjects.length === 0 ||
    typeof evidence.resumeDurable !== "boolean" ||
    typeof evidence.stable !== "boolean"
  )
    return unsupported("The provider returned incomplete process-control evidence.");
  if (!evidence.protocolSupported)
    return unsupported("The provider protocol could not establish safe process control.");
  if (!evidence.trackingComplete)
    return unsupported("Protocol tracking capacity was exceeded. The process was left running.");
  if (!evidence.inventoryComplete)
    return unsupported("The provider could not supply a complete work inventory.");
  if (evidence.pendingWork)
    return busy("Work or requests are pending.");
  for (const subject of evidence.subjects) {
    if (
      !subject ||
      typeof subject !== "object" ||
      !values.execution.has(subject.execution) ||
      !values.goal.has(subject.goal) ||
      !values.background.has(subject.background) ||
      !values.scheduled.has(subject.scheduled)
    )
      return unsupported("The provider returned incomplete process-control evidence.");
    if (
      subject.execution === "unknown" ||
      subject.goal === "unknown" ||
      subject.background === "unknown" ||
      subject.scheduled === "unknown"
    )
      return unsupported("The provider returned an unknown process-control state.");
    if (
      subject.execution === "active" ||
      subject.goal === "unfinished" ||
      subject.background === "present" ||
      subject.scheduled === "present"
    )
      return busy("Provider work or scheduled activity is pending.");
  }
  if (!evidence.resumeDurable)
    return busy("Conversation history is not durably saved.");
  if (!evidence.stable)
    return busy("New work arrived during the safety inspection.");
  return { status: "safe" };
}
