// Provider compatibility facade. Native ownership is established by a private launch recipe.
// The test owns either parent IPC or an authenticated Unix socket/named pipe.
// Provider stdout stays Codex RPC; no debugger, host monkeypatch, or TCP listener.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { listenControl } from "./control.mjs";
import { createControlledSession } from "./controlled-session.mjs";
import { claimProxyConnection } from "../proxy-launch.mjs";
import { ownProxyLease } from "../proxy-lease.mjs";
import { createReplyCache } from "../proxy-cache.mjs";
import {
  pumpJsonLines,
  writeJsonLine,
  writeProtocolBytes,
  createProtocolWriter,
} from "../proxy-wire.mjs";
import { createProtocolTracker } from "../proxy-tracker.mjs";
import { createEncryptedReplay, encodeJson, ReplayInterrupted } from "../proxy-replay.mjs";
import { createMemoryReclaimer, createMemorySampler } from "./memory.mjs";
import { nativeCommand, signalNative } from "../platform.mjs";
const sampleMemory = createMemorySampler();
const reclaimer = createMemoryReclaimer();

if (process.env.RUNTIME_PROXY_RECIPE_FILE)
  Object.assign(
    process.env,
    await claimProxyConnection(process.env.RUNTIME_PROXY_RECIPE_FILE, "codex"),
  );
if (!process.env.RUNTIME_PROXY_SOCKET && process.env.RUNTIME_PROXY_FIXTURE !== "1")
  throw new Error("Private runtime launch recipe required");
const [executable, ...args] = process.argv.slice(2);
if (!executable || !args.includes("app-server"))
  throw new Error("Expected Codex app-server command");
const releaseLease = await ownProxyLease("codex");
const prefix = `free-your-agents-${randomUUID()}:`;
const cache = createReplyCache();
const replay = await createEncryptedReplay({
  parentDirectory:
    process.env.RUNTIME_PROXY_FIXTURE === "1"
      ? process.env.RUNTIME_PROXY_TEST_REPLAY_PARENT
      : undefined,
  ...(process.env.RUNTIME_PROXY_FIXTURE === "1" && process.env.RUNTIME_PROXY_TEST_REPLAY_LIMIT
    ? { maxEntryBytes: Number(process.env.RUNTIME_PROXY_TEST_REPLAY_LIMIT) }
    : {}),
});
const historyThreads = createProtocolTracker({ maxEntries: 100 });
const forwarded = createProtocolTracker();
const internal = new Map();
const serverRequests = createProtocolTracker();
const turns = createProtocolTracker();
const methods = new Set();
const results = new Map();
const reads = new Set([
  "model/list",
  "config/read",
  "getUserSavedConfig",
  "collaborationMode/list",
  "skills/list",
  "thread/read",
  "thread/goal/get",
  "thread/backgroundTerminals/list",
]);
const session = createControlledSession({
  isPassiveClientFrame: (message) =>
    typeof message?.method === "string" &&
    Object.hasOwn(message, "id") &&
    reads.has(message.method),
});
// Codex reports a failed turn as systemError after execution has stopped.
// Goal, terminal, request, history, and activity-revision guards below still
// have to prove that the thread is safe to release.
const settledThreadStatuses = new Set(["idle", "systemError"]);
let phase = "starting",
  child = null,
  generation = null,
  spawns = 0,
  serial = 0;
let initialize = null,
  root = null,
  providerVersion = null;
let saved = true,
  quitting = false,
  suppressNotifications = false;
let tail = Promise.resolve();
let protocolSupported = false;
let boundedMethods = true;
let closeControl = async () => {};
const unfinishedGoals = createProtocolTracker();
const trackingComplete = () =>
  boundedMethods &&
  [forwarded, serverRequests, turns, unfinishedGoals, historyThreads].every((tracker) =>
    tracker.valid(),
  );

function enqueue(work) {
  const next = tail.then(work);
  tail = next.catch((error) => {
    process.stderr.write(`Free Your Agents operation failed: ${error.message}\n`);
  });
  return next;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const key = (method, params) => JSON.stringify([method, canonical(params ?? {})]);
const writer = createProtocolWriter(process.stdout);
const output = (value) => writer.send(value);
const replayKey = (params) => generation + ":" + key("thread/read", params);
function errorResponse(id, message) {
  return output({ id, error: { code: -32001, message } });
}
async function snapshot() {
  return {
    ...(await sampleMemory(child?.pid)),
    bridgeHeapBytes: process.memoryUsage().heapUsed,
    controlVersion: 1,
    connectionId: process.env.RUNTIME_PROXY_CONNECTION_ID ?? null,
    agentId: process.env.RUNTIME_PROXY_AGENT_ID ?? null,
    providerVersion,
    releaseSupported: protocolSupported && trackingComplete(),
    unavailableReason: trackingComplete()
      ? undefined
      : "Protocol tracking capacity was exceeded. The process was left running.",
    phase,
    generation,
    proxyPid: process.pid,
    nativePid: child?.pid ?? null,
    spawns,
    threadId: root?.thread.id ?? null,
    activeTurns: turns.size,
    pendingRequests: forwarded.size,
    pendingServerRequests: serverRequests.size,
    unfinishedGoals: unfinishedGoals.size,
    methods: [...methods].sort(),
    cacheEntries: cache.stats().entries,
    cacheBytes: cache.stats().bytes,
    cacheByteLimit: cache.stats().maxBytes,
    replayEntries: replay.stats().entries,
    replayBytes: replay.stats().bytes,
    replayByteLimit: replay.stats().maxBytes,
  };
}
// Pass the source frame when the message is forwarded unchanged.
function write(message, frame) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    throw new Error("Codex CLI is not running");
  return frame ? writeProtocolBytes(child.stdin, frame) : writeJsonLine(child.stdin, message);
}
function request(method, params = {}) {
  const id = prefix + ++serial;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      internal.delete(id);
      reject(new Error(`Internal ${method} timeout`));
    }, 5_000);
    internal.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    });
    void write({ id, method, params }).catch((error) => {
      const pending = internal.get(id);
      internal.delete(id);
      pending?.reject(error);
    });
  });
}
function notification(message) {
  const params = message.params ?? {};
  if (message.method === "thread/goal/updated") {
    if (params.goal?.status === "complete") unfinishedGoals.delete(params.threadId);
    else unfinishedGoals.add(params.threadId);
    return true;
  }
  if (message.method === "thread/goal/cleared") {
    unfinishedGoals.delete(params.threadId);
    return true;
  }
  if (message.method === "turn/started") {
    turns.add(params.threadId + ":" + params.turn?.id);
    return true;
  }
  if (message.method === "turn/completed") {
    turns.delete(params.threadId + ":" + params.turn?.id);
    return true;
  }
  if (message.method === "serverRequest/resolved") {
    serverRequests.delete(params.requestId);
    return true;
  }
  if (message.method === "thread/started") return true;
  if (message.method === "thread/status/changed")
    return !settledThreadStatuses.has(message.params?.status?.type);
  return false;
}
async function receive(message, frame, exchange) {
  if (Object.hasOwn(message, "id") && !message.method) {
    const pending = internal.get(message.id);
    if (pending) {
      internal.delete(message.id);
      if (message.error)
        pending.reject(
          Object.assign(new Error(message.error.message), { code: message.error.code }),
        );
      else pending.resolve(message.result);
      return;
    }
    // A large history may arrive after its inspection timed out. Our reserved
    // IDs never belong to Paseo; consume late replies rather than leaking them.
    if (typeof message.id === "string" && message.id.startsWith(prefix)) return;
    const original = forwarded.get(message.id);
    forwarded.delete(message.id);
    if (original && !message.error) {
      if (original.method === "thread/read") historyThreads.add(original.params?.threadId);
      if (
        reads.has(original.method) &&
        !(original.method === "thread/read" && original.params?.includeTurns === true)
      )
        cache.set(key(original.method, original.params), message.result);
      if (original.method === "initialize") {
        initialize = original.params;
        providerVersion =
          typeof message.result?.userAgent === "string" ? message.result.userAgent : null;
        // The version is diagnostic metadata. Successful initialization and
        // the release-time structural probes below establish compatibility.
        protocolSupported = true;
      }
      if (original.method === "thread/start" || original.method === "thread/resume") {
        // Retain identity only. Native resume/start replies can contain the
        // entire transcript; replay storage has its own explicit byte budget.
        if (!root) root = { thread: { id: message.result.thread.id } };
      }
    }
  } else if (message.method && Object.hasOwn(message, "id")) {
    exchange.invalidate();
    serverRequests.add(message.id);
  }
  else if (message.method) {
    if (notification(message)) exchange.invalidate();
    if (suppressNotifications) return;
  }
  await (frame ? writer.forward(frame) : output(message));
}
async function launch() {
  const incarnation = session.control({ op: "replace" });
  const nativeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("RUNTIME_PROXY_") &&
        name !== "NODE_CHANNEL_FD" &&
        name !== "NODE_CHANNEL_SERIALIZATION_MODE",
    ),
  );
  const native = nativeCommand(executable, args, nativeEnv);
  const spawned = spawn(native.file, native.args, {
    ...native.options,
    env: nativeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = spawned;
  generation = randomUUID();
  spawns++;
  void pumpJsonLines(spawned.stdout, (message, frame) => {
    reclaimer.note(frame);
    const exchange = session.exchange("provider", { incarnation, message });
    if (!exchange.accepted) return;
    return receive(message, frame, exchange).finally(exchange.settle);
  }).catch((error) =>
    shutdown(1, `Invalid provider protocol: ${error.message}`),
  );
  // In the experiment only, retain stderr in the harness process's diagnostic
  // stream. Production packaging must avoid logging prompts or credentials.
  spawned.stderr.pipe(process.stderr, { end: false });
  spawned.on("error", (error) => {
    void shutdown(1, error.message);
  });
  spawned.on("exit", () => {
    for (const pending of internal.values()) pending.reject(new Error("Codex exited"));
    internal.clear();
    if (child === spawned && phase !== "stopping" && !quitting)
      void shutdown(1, "Unexpected Codex exit");
  });
  await once(spawned, "spawn");
}
async function stopChild() {
  const stopping = child;
  if (!stopping) return;
  if (stopping.exitCode === null && stopping.signalCode === null) {
    const exited = once(stopping, "exit");
    // Only the group or tree created by this proxy is addressed. No PID
    // scanning/killing of other Paseo agents is used.
    const signal = (name) => signalNative(stopping, name);
    signal("SIGTERM");
    const timeout = setTimeout(() => signal("SIGKILL"), 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (child === stopping) child = null;
}
async function shutdown(code = 0, message) {
  if (quitting) return;
  quitting = true;
  if (message) process.stderr.write(message + "\n");
  await stopChild();
  await closeControl();
  await replay.close().catch(() => {
    process.stderr.write("Encrypted replay cleanup could not complete.\n");
  });
  await releaseLease();
  process.exit(code);
}
async function wake() {
  if (phase !== "released") return;
  await replay.clear();
  phase = "starting";
  suppressNotifications = true;
  try {
    const metadata = cache
      .keys()
      .filter((encoded) => !JSON.parse(encoded)[0].startsWith("thread/"));
    await launch();
    await request("initialize", initialize);
    await write({ method: "initialized", params: {} });
    const previousId = root.thread.id;
    if (!saved) throw new Error("A conversation without saved history must not be released");
    const resumed = await request("thread/resume", { threadId: previousId });
    if (resumed.thread.id !== previousId)
      throw new Error("Native thread identity changed unexpectedly");
    root = { thread: { id: resumed.thread.id } };
    cache.clear();
    for (const encoded of metadata) {
      const [method, params] = JSON.parse(encoded);
      cache.set(encoded, await request(method, params));
    }
    phase = "running";
    return previousId;
  } finally {
    suppressNotifications = false;
  }
}
async function release(expectedGeneration) {
  if (phase === "released") return { status: "absent" };
  if (expectedGeneration !== generation) return { status: "generation-changed" };
  if (phase !== "running" || !root || !initialize)
    return { status: "busy", reason: "Not initialized" };
  if (!protocolSupported)
    return {
      status: "unsupported",
      reason: "The Codex protocol contract could not be validated for process control",
    };
  if (!trackingComplete())
    return {
      status: "unsupported",
      reason: "Protocol tracking capacity was exceeded. The process was left running.",
    };
  if (
    forwarded.size ||
    serverRequests.size ||
    turns.size ||
    session.control({ op: "snapshot" }).admissions
  )
    return { status: "busy", reason: "Work or requests pending" };
  const checkpoint = session.control({ op: "checkpoint" });
  const loaded = await request("thread/loaded/list");
  if (!Array.isArray(loaded.data) || !loaded.data.includes(root.thread.id))
    throw new Error("Cannot establish loaded thread ownership");
  if (loaded.nextCursor != null)
    return {
      status: "unsupported",
      reason: "The provider could not supply a complete work inventory.",
    };
  if (loaded.data.length > 100)
    return {
      status: "unsupported",
      reason: "Too many native threads to capture a complete replay safely.",
    };
  let rootSnapshot;
  const subjects = [];
  for (const id of loaded.data) {
    const result = await request("thread/read", { threadId: id, includeTurns: false });
    const type = result.thread?.status?.type;
    const goal = await request("thread/goal/get", { threadId: id });
    const background = await request("thread/backgroundTerminals/list", { threadId: id, limit: 1 });
    const goalValue = Object.hasOwn(goal, "goal") ? goal.goal : undefined;
    const goalState =
      goalValue === null
        ? "complete"
        : goalValue &&
            typeof goalValue === "object" &&
            !Array.isArray(goalValue) &&
            typeof goalValue.status === "string" &&
            goalValue.status.length > 0
          ? goalValue.status === "complete"
            ? "complete"
            : "unfinished"
          : "unknown";
    const backgroundState = !Array.isArray(background.data)
      ? "unknown"
      : background.data.length || background.nextCursor != null
        ? "present"
        : "none";
    if (goalState === "complete") unfinishedGoals.delete(id);
    subjects.push({
      execution: settledThreadStatuses.has(type)
        ? "settled"
        : type === "active"
          ? "active"
          : "unknown",
      goal: goalState,
      background: backgroundState,
      scheduled: "none",
    });
    if (id === root.thread.id) rootSnapshot = result;
  }
  if (!rootSnapshot) throw new Error("Root thread snapshot is missing");
  const path = rootSnapshot.thread.path;
  saved = typeof path === "string" && (await stat(path).catch(() => null))?.size > 0;
  if (!saved)
    return { status: "busy", reason: "Send the first message before stopping this Codex runtime." };
  // Capture exact native replies, including historical provider children. A
  // cache budget failure leaves native alive rather than losing passive history.
  cache.unpin();
  try {
    await replay.clear();
  } catch {
    return {
      status: "unsupported",
      reason: "Encrypted history storage is unavailable. The process was left running.",
    };
  }
  const histories = new Set([...loaded.data, ...historyThreads.ids()]);
  for (const encoded of cache.keys()) {
    const [method, params] = JSON.parse(encoded);
    if (method === "thread/read" && typeof params.threadId === "string")
      histories.add(params.threadId);
  }
  for (const id of histories) {
    if (histories.size > 100)
      return {
        status: "unsupported",
        reason: "The complete conversation history exceeds this adapter's replay capacity.",
      };
    const history = await request("thread/read", { threadId: id, includeTurns: true });
    if (history.thread?.id !== id || !Array.isArray(history.thread.turns))
      throw new Error("Incomplete native history response");
    if (
      !(await replay.capture(replayKey({ threadId: id, includeTurns: true }), encodeJson(history)))
    )
      return {
        status: "unsupported",
        reason:
          "The complete conversation history could not be saved within the encrypted replay budget. The process was left running.",
      };
    for (const turn of history.thread.turns)
      for (const item of turn.items ?? []) {
        const type =
          typeof item.type === "string" ? item.type.replace(/[_-]/g, "").toLowerCase() : "";
        if (
          type === "subagentactivity" &&
          item.kind === "started" &&
          typeof item.agentThreadId === "string"
        )
          histories.add(item.agentThreadId);
        if (
          type === "collabagenttoolcall" &&
          item.tool === "spawnAgent" &&
          Array.isArray(item.receiverThreadIds)
        )
          for (const childId of item.receiverThreadIds)
            if (typeof childId === "string" && childId) histories.add(childId);
      }
  }
  if (!trackingComplete())
    return {
      status: "unsupported",
      reason:
        "Protocol tracking capacity was exceeded during inspection. The process was left running.",
    };
  if (
    !cache.set(
      key("thread/read", { threadId: root.thread.id, includeTurns: false }),
      rootSnapshot,
      { required: true },
    )
  )
    return {
      status: "unsupported",
      reason: "The conversation snapshot could not be retained. The process was left running.",
    };
  if (!(await replay.verifyAll()))
    return {
      status: "unsupported",
      reason: "Encrypted history verification failed. The process was left running.",
    };
  const verdict = session.control({
    op: "release",
    checkpoint,
    evidence: {
      protocolSupported,
      trackingComplete: trackingComplete(),
      inventoryComplete: true,
      pendingWork:
        forwarded.size + serverRequests.size + turns.size + unfinishedGoals.size,
      subjects,
      resumeDurable: saved,
      stable: true,
    },
  });
  if (verdict.status !== "safe") return verdict;
  phase = "stopping";
  await stopChild();
  phase = "released";
  reclaimer.released(() => phase === "released");
  return { status: "released", saved };
}
async function incoming(message, frame) {
  if (!message.method) {
    serverRequests.delete(message.id);
    await write(message, frame);
    return;
  }
  if (
    typeof message.method === "string" &&
    message.method.length <= 128 &&
    (methods.has(message.method) || methods.size < 128)
  )
    methods.add(message.method);
  else boundedMethods = false;
  const isRequest = Object.hasOwn(message, "id");
  if (phase === "released") {
    if (!isRequest && message.method !== "turn/start") return;
    if (message.method === "thread/loaded/list") {
      await output({ id: message.id, result: { data: [root.thread.id] } });
      return;
    }
    if (message.method === "thread/read" && replay.has(replayKey(message.params))) {
      const replayed = await writer.transaction((write) =>
        replay.replay(replayKey(message.params), {
          prefix: Buffer.from('{"id":' + JSON.stringify(message.id) + ',"result":'),
          suffix: Buffer.from("}\n"),
          write(chunk) {
            reclaimer.note(chunk);
            return write(chunk);
          },
        }),
      );
      if (!replayed)
        await errorResponse(
          message.id,
          "The encrypted conversation history is unavailable or damaged. Send a message to resume.",
        );
      return;
    }
    if (reads.has(message.method) && cache.has(key(message.method, message.params))) {
      await output({ id: message.id, result: cache.get(key(message.method, message.params)) });
      return;
    }
    if (message.method !== "turn/start") {
      if (isRequest)
        await errorResponse(
          message.id,
          "Runtime is stopped; this operation has no cached response. Send a message to resume.",
        );
      return;
    }
    await wake();
  }
  // Prompt payloads are already forwarded to native; retain no second copy
  // merely to correlate the response. Reads/initialize alone need their params.
  if (isRequest)
    forwarded.set(message.id, {
      method: message.method,
      ...(reads.has(message.method) || message.method === "initialize"
        ? { params: message.params }
        : {}),
    });
  await write(message, frame);
}

async function control(message) {
  if (message.op === "snapshot") return snapshot();
  return enqueue(async () => {
    if (message.op !== "release") throw new Error("Unknown control operation");
    const previous = results.get(message.id);
    if (previous && previous.expectedGeneration !== message.expectedGeneration)
      throw new Error("Control request ID reused with different generation");
    if (previous) return previous.result;
    const result = await release(message.expectedGeneration);
    // A due schedule retries the same operation after work finishes. Busy is
    // provisional; memoizing it would leave that schedule deferred forever.
    if (result.status !== "busy" && result.status !== "unsupported") {
      results.set(message.id, { expectedGeneration: message.expectedGeneration, result });
    }
    // Retain recent outcomes. Even after eviction, generation matching prevents
    // an old operation from stopping any replacement native runtime.
    if (results.size > 128) results.delete(results.keys().next().value);
    return result;
  });
}
process.on("message", (message) => {
  void control(message).then(
    (result) => process.send?.({ id: message.id, result }),
    (error) => process.send?.({ id: message.id, error: error.message }),
  );
});
if (process.env.RUNTIME_PROXY_SOCKET) {
  closeControl = await listenControl({
    path: process.env.RUNTIME_PROXY_SOCKET,
    token: process.env.RUNTIME_PROXY_TOKEN,
    handle: control,
  });
}
await launch();
phase = "running";
void pumpJsonLines(process.stdin, async (message, frame) => {
  reclaimer.note(frame);
  const admission = session.exchange("client", message);
  await enqueue(async () => {
    admission.settle();
    try {
      await incoming(message, frame);
    } catch (error) {
      if (error instanceof ReplayInterrupted) {
        await shutdown(1, "Encrypted history replay was interrupted");
        return;
      }
      if (Object.hasOwn(message, "id")) await errorResponse(message.id, error.message);
      else await shutdown(1, error.message);
    }
  });
}).then(
  () => shutdown(),
  (error) => shutdown(1, "Invalid client protocol: " + error.message),
);
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
process.on("disconnect", () => {
  void shutdown();
});
