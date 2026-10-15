import type { LocalTabsApi, LocalTabsState } from "../shared/model";

export interface ReporterRpc {
  register(ownerId: string): Promise<string>;
  publish(input: {
    ownerId: string;
    epoch: string;
    revision: number;
    agentIds: string[];
    sharedAgentIds?: string[];
  }): Promise<boolean>;
}

export function startReporter(
  tabs: LocalTabsApi,
  rpc: ReporterRpc,
  reportError: (error: unknown) => void,
  intervalMs = 15_000,
) {
  let latest: LocalTabsState | null = null;
  let epoch: string | null = null;
  let ownerId: string | null = null;
  let disposed = false;
  let sending = false;
  let changed = false;

  async function flush() {
    if (sending || disposed || !latest || latest.status !== "ready") return;
    sending = true;
    changed = false;
    const snapshot = latest;
    try {
      if (ownerId !== snapshot.ownerId || epoch === null) {
        epoch = await rpc.register(snapshot.ownerId);
        ownerId = snapshot.ownerId;
      }
      if (disposed) return;
      const accepted = await rpc.publish({
        ownerId: snapshot.ownerId,
        epoch,
        revision: snapshot.revision,
        agentIds: [...snapshot.agentIds],
        sharedAgentIds: [...(snapshot.sharedAgentIds ?? [])],
      });
      if (!accepted) epoch = null;
    } catch (error) {
      reportError(error);
    } finally {
      sending = false;
      if (changed && !disposed) void flush();
    }
  }
  const stopObserve = tabs.observe((snapshot) => {
    latest = snapshot;
    changed = true;
    void flush();
  });
  const timer = setInterval(() => void flush(), intervalMs);
  return () => {
    disposed = true;
    clearInterval(timer);
    stopObserve();
    // Plugin unload and a lost connection do not confirm that the window's tabs closed.
  };
}
