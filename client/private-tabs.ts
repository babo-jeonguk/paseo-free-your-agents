import type { LocalTabsApi, LocalTabsState } from "../shared/model";

type Value = Record<string, unknown>;
const object = (value: unknown): Value | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Value) : null;
type LayoutStore = {
  getState(): unknown;
  subscribe(listener: () => void): () => void;
  persist: {
    hasHydrated(): boolean;
    onFinishHydration(listener: () => void): () => void;
  };
};

// This adapter is intentionally read-only and private-version dependent. Only
// known store methods are called. Do not replace host methods, invoke setters,
// serialize fibers, or use a missing ref/store as an empty tab inventory.
function findLayoutStore(ref: unknown): LayoutStore | null {
  const host = object(ref);
  if (!host) return null;
  const key = Object.getOwnPropertyNames(host).find((name) => name.startsWith("__reactFiber$"));
  let root = object(host.__internalInstanceHandle ?? (key ? host[key] : null));
  if (!root) return null;
  const parents = new Set<unknown>();
  while (object(root.return)) {
    if (parents.has(root)) return null;
    parents.add(root);
    root = object(root.return)!;
  }
  root = object(object(root.stateNode)?.current) ?? root;
  const nodes: unknown[] = [root],
    seen = new Set<unknown>();
  while (nodes.length && seen.size < 40_000) {
    const node = object(nodes.pop());
    if (!node || seen.has(node)) continue;
    seen.add(node);
    nodes.push(node.child, node.sibling);
    let hook = object(node.memoizedState);
    for (let i = 0; hook && i < 500; i++, hook = object(hook.next)) {
      const value = hook.memoizedState;
      if (!Array.isArray(value) || !Array.isArray(value[1])) continue;
      for (const entry of value[1]) {
        const candidate = object(entry);
        if (!candidate) continue;
        const getState = Object.getOwnPropertyDescriptor(candidate, "getState")?.value;
        const subscribe = Object.getOwnPropertyDescriptor(candidate, "subscribe")?.value;
        if (typeof getState !== "function" || typeof subscribe !== "function") continue;
        try {
          const state = object(getState());
          const persist = object(candidate.persist);
          if (
            !state ||
            !object(state.layoutByWorkspace) ||
            !persist ||
            typeof persist.hasHydrated !== "function" ||
            typeof persist.onFinishHydration !== "function"
          )
            continue;
          return candidate as unknown as LayoutStore;
        } catch {
          /* An unrelated store is not a layout source. */
        }
      }
    }
  }
  return null;
}

function inventory(value: unknown, hostId: string) {
  const layouts = object(object(value)?.layoutByWorkspace);
  if (!layouts) throw new Error("Unsupported layout state");
  const ids = new Set<string>(),
    shared = new Set<string>(),
    seen = new Set<unknown>();
  for (const [key, layout] of Object.entries(layouts)) {
    if (!key.startsWith(hostId + ":")) continue;
    const nodes: unknown[] = [object(layout)?.root];
    while (nodes.length) {
      const node = object(nodes.pop());
      if (!node || seen.has(node) || seen.size >= 20_000)
        throw new Error("Unsupported layout tree");
      seen.add(node);
      if (node.kind === "group") {
        const children = object(node.group)?.children;
        if (!Array.isArray(children)) throw new Error("Unsupported layout group");
        nodes.push(...children);
        continue;
      }
      const tabs = object(node.pane)?.tabs;
      if (node.kind !== "pane" || !Array.isArray(tabs)) throw new Error("Unsupported layout pane");
      for (const tab of tabs) {
        const target = object(object(tab)?.target);
        if (!target || typeof target.kind !== "string") throw new Error("Unsupported tab target");
        if (target.kind === "agent") {
          if (typeof target.agentId !== "string" || !target.agentId)
            throw new Error("Invalid agent tab");
          ids.add(target.agentId);
        }
        if (target.kind === "provider_subagent") {
          if (typeof target.parentAgentId !== "string" || !target.parentAgentId)
            throw new Error("Invalid shared tab");
          ids.add(target.parentAgentId);
          shared.add(target.parentAgentId);
        }
      }
    }
  }
  return { agentIds: [...ids].sort(), sharedAgentIds: [...shared].sort() };
}

export function createPrivateTabs(input: {
  hostId: string;
  owner: () => Promise<string>;
  onError: (message: string) => void;
}) {
  const listeners = new Set<(state: LocalTabsState) => void>();
  const statusListeners = new Set<() => void>();
  let ownerId = "pending",
    revision = 0,
    signature = "",
    ready = false,
    disposed = false,
    store: LayoutStore | null = null;
  let latest: LocalTabsState = {
    status: "loading",
    ownerId,
    revision,
    agentIds: [],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0,
    stopStore = () => {},
    stopHydration = () => {};
  function emit(state: LocalTabsState) {
    latest = state;
    for (const listener of listeners) listener(state);
  }
  function status(value: boolean) {
    if (ready === value) return;
    ready = value;
    for (const listener of statusListeners) listener();
  }
  function publish() {
    if (disposed || !store) return;
    try {
      if (!store.persist.hasHydrated() || ownerId === "pending") {
        emit({ status: "loading", ownerId, revision, agentIds: [] });
        return;
      }
      const current = inventory(store.getState(), input.hostId);
      const next = JSON.stringify(current);
      status(true);
      if (next === signature && latest.status === "ready") return;
      signature = next;
      revision++;
      emit({ status: "ready", ownerId, revision, ...current });
    } catch {
      status(false);
      emit({ status: "loading", ownerId, revision, agentIds: [] });
      input.onError("Open-tab state could not be verified. Keeping the last reported inventory.");
    }
  }
  function attach(ref: unknown) {
    if (disposed || store || !ref) return;
    clearTimeout(timer);
    const discover = () => {
      if (disposed || store) return;
      const found = findLayoutStore(ref);
      if (!found) {
        if (++attempts < 40) timer = setTimeout(discover, 250);
        else input.onError("This Paseo build does not expose a compatible open-tab source.");
        return;
      }
      store = found;
      stopStore = store.subscribe(publish);
      stopHydration = store.persist.onFinishHydration(publish);
      publish();
    };
    timer = setTimeout(discover, 0);
  }
  void input
    .owner()
    .then((id) => {
      if (!disposed) {
        ownerId = id;
        publish();
      }
    })
    .catch(() => {
      input.onError(
        "Window ownership could not be established. No tab inventory will be replaced.",
      );
    });
  const api: LocalTabsApi = {
    observe(listener) {
      listeners.add(listener);
      listener(latest);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    attach,
    supported: () => ready,
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      stopStore();
      stopHydration();
      listeners.clear();
      statusListeners.clear();
    },
  };
}
