// Provider compatibility: a Claude stdio facade. Not published or enabled on the host.
// Release follows the CLI's documented contract: idle is the authoritative
// turn-over signal, background_tasks_changed is the level set of live background
// work, and the SDK Stop hook reports scheduled wakeups. A release ends input and
// lets native finish anything it started itself before exiting; it is never
// killed mid-turn. Never reinitialize a running CLI to probe it: that can cancel
// existing hook requests.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { listenControl } from "./control.mjs";
import { createControlledSession } from "./controlled-session.mjs";
import { claimProxyConnection } from "../proxy-launch.mjs";
import { ownProxyLease } from "../proxy-lease.mjs";
import { createReplyCache } from "../proxy-cache.mjs";
import { pumpJsonLines, writeJsonLine, writeProtocolBytes } from "../proxy-wire.mjs";
import { createProtocolTracker } from "../proxy-tracker.mjs";
import { createMemoryReclaimer, createMemorySampler } from "./memory.mjs";
import { nativeCommand, signalNative } from "../platform.mjs";
const sampleMemory = createMemorySampler();
const reclaimer = createMemoryReclaimer();

const [binary, ...originalArgs] = process.argv.slice(2);
if (!binary) throw new Error("Claude command required");
// Native Claude accepts SDK hooks in these modes but never calls them.
const hooksDisabled =
  originalArgs.includes("--bare") ||
  (process.env.RUNTIME_PROXY_FIXTURE !== "1" && !!process.env.CLAUDE_CODE_SIMPLE);
const configuredStartupTimeout = Number(process.env.RUNTIME_PROXY_STARTUP_TIMEOUT_MS);
const startupTimeoutMs =
  process.env.RUNTIME_PROXY_FIXTURE === "1" &&
  Number.isFinite(configuredStartupTimeout) &&
  configuredStartupTimeout > 0
    ? configuredStartupTimeout
    : 30_000;
if (process.env.RUNTIME_PROXY_RECIPE_FILE)
  Object.assign(
    process.env,
    await claimProxyConnection(process.env.RUNTIME_PROXY_RECIPE_FILE, "claude"),
  );
const releaseLease = await ownProxyLease("claude");
const hookId = "free-your-agents-stop-" + randomUUID();
const forwarded = createProtocolTracker(),
  serverRequests = createProtocolTracker(),
  internal = new Map(),
  outcomes = new Map();
const settings = [],
  reads = createReplyCache();
const readTypes = new Set(["get_settings", "get_context_usage", "mcp_status"]);
const isPassiveClientFrame = (message) =>
  message?.type === "control_request" && readTypes.has(message.request?.subtype);
const session = createControlledSession({
  isPassiveClientFrame,
});
const settingTypes = new Set([
  "set_model",
  "set_permission_mode",
  "set_max_thinking_tokens",
  "apply_flag_settings",
]);
let settingsBytes = 0;
const trackingComplete = () => forwarded.valid() && serverRequests.valid();
let child,
  generation,
  spawns = 0,
  phase = "starting",
  tail = Promise.resolve(),
  quitting = false;
let initializeSeen = false,
  initializer = null,
  sessionId = null,
  version = null,
  nativeState = "unknown",
  inventory = null,
  draining = null;
// Native requests abandoned by an exited process; late client answers are moot.
const abandoned = new Set();
let activeUsers = 0,
  goalState = "complete",
  backgroundTasks = 0,
  protocolSupported = true;
let closeControl = async () => {};
const output = (value) => writeJsonLine(process.stdout, value);
// Pass the source frame when the message is forwarded unchanged.
function write(value, frame) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.stdin.writableEnded)
    throw new Error("Claude is not running");
  return frame ? writeProtocolBytes(child.stdin, frame) : writeJsonLine(child.stdin, value);
}
function enqueue(work) {
  const result = tail.then(work);
  tail = result.catch(() => {});
  return result;
}
function attachHook(request) {
  if (hooksDisabled) return request;
  return {
    ...request,
    hooks: {
      ...request.hooks,
      Stop: [...(request.hooks?.Stop ?? []), { hookCallbackIds: [hookId] }],
    },
  };
}
function reply(id, response = {}, error) {
  return output({
    type: "control_response",
    response: {
      subtype: error ? "error" : "success",
      request_id: id,
      ...(error ? { error } : { response }),
    },
  });
}
async function receive(message, frame) {
  if (message.type === "control_request") {
    const request = message.request;
    if (request?.subtype === "hook_callback" && request.callback_id === hookId) {
      const input = request.input;
      // The last completed turn's scheduled wakeups. They survive a stop (resume
      // restores them) but would not fire while released.
      inventory =
        input?.hook_event_name === "Stop" && Array.isArray(input.session_crons)
          ? { crons: input.session_crons.length, transcript: input.transcript_path }
          : null;
      // A draining native has no input left to read a reply from.
      if (child?.stdin.writableEnded) return;
      // Even our observing callback remains outstanding until its reply has
      // reached native. A slow stdin must not look idle during that write.
      serverRequests.add(message.request_id);
      try {
        await write({
          type: "control_response",
          response: { subtype: "success", request_id: message.request_id, response: {} },
        });
      } finally {
        serverRequests.delete(message.request_id);
      }
      return;
    }
    serverRequests.add(message.request_id);
  }
  if (message.type === "control_cancel_request") {
    serverRequests.delete(message.request_id);
  }
  if (message.type === "control_response") {
    const id = message.response?.request_id;
    const pending = internal.get(id);
    if (pending) {
      internal.delete(id);
      if (message.response.subtype === "error") pending.reject(new Error(message.response.error));
      else pending.resolve(message.response.response);
      return;
    }
    const request = forwarded.get(id);
    forwarded.delete(id);
    if (request && message.response.subtype === "success") {
      if (readTypes.has(request.subtype))
        reads.set(JSON.stringify(request), message.response.response ?? {});
      else if (request.subtype !== "initialize" && request.subtype !== "interrupt") {
        const bytes = Buffer.byteLength(JSON.stringify(request));
        if (
          settingTypes.has(request.subtype) &&
          settings.length < 64 &&
          settingsBytes + bytes <= 256 * 1024
        ) {
          settings.push(request);
          settingsBytes += bytes;
        } else protocolSupported = false;
      }
    }
  }
  if (message.type === "system" && message.subtype === "init") {
    version = typeof message.claude_code_version === "string" ? message.claude_code_version : null;
    // The turn is already running, so an unusable session fails closed in place.
    if (typeof message.session_id !== "string" || !message.session_id) protocolSupported = false;
    else {
      if (sessionId && sessionId !== message.session_id)
        throw new Error("Claude session identity changed");
      sessionId = message.session_id;
    }
  }
  if (message.type === "system" && message.subtype === "session_state_changed") {
    nativeState = message.state;
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    if (!Array.isArray(message.tasks)) protocolSupported = false;
    else backgroundTasks = message.tasks.length;
  }
  if (message.type === "active_goal") {
    // Native Claude reports a goal only when its /goal Stop hook clears it
    // (null, or no value once undefined is serialized) or keeps it unfinished.
    goalState =
      message.value == null
        ? "complete"
        : typeof message.value === "object"
          ? "unfinished"
          : "unknown";
  }
  if (message.type === "result") {
    activeUsers = Math.max(0, activeUsers - 1);
  }
  await (frame ? writeProtocolBytes(process.stdout, frame) : output(message));
}
async function launch(resume = false) {
  const incarnation = session.control({ op: "replace" });
  let args = [...originalArgs];
  if (resume) {
    const filtered = [];
    for (let index = 0; index < args.length; index++) {
      if (["--resume", "--session-id"].includes(args[index])) {
        index++;
        continue;
      }
      if (/^--(resume|session-id)=/.test(args[index])) continue;
      filtered.push(args[index]);
    }
    args = [...filtered, "--resume", sessionId];
  }
  // Fixture-only allowlist; excludes inherited OAuth secrets and SIMPLE mode,
  // which would disable the Stop hook this experiment needs to observe work.
  const nativeEnv =
    process.env.RUNTIME_PROXY_FIXTURE === "1"
      ? Object.fromEntries(
          [
            "PATH",
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "DISABLE_AUTOUPDATER",
            "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
          ]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        )
      : Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !name.startsWith("RUNTIME_PROXY_") &&
              !["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].includes(name),
          ),
        );
  const native = nativeCommand(binary, args, nativeEnv);
  const current = spawn(native.file, native.args, {
    ...native.options,
    env: nativeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = current;
  generation = randomUUID();
  spawns++;
  // The background level is per process and is not re-sent at startup.
  nativeState = "unknown";
  backgroundTasks = 0;
  inventory = null;
  // A pursued goal keeps native running instead of idle, and a deferred one
  // waits on background work, so only an explicit report can mark it unfinished.
  goalState = "complete";
  void pumpJsonLines(current.stdout, (message, frame) => {
    reclaimer.note(frame);
    const exchange = session.exchange("provider", { incarnation, message });
    if (!exchange.accepted) return;
    if (changesEvidence(message)) exchange.invalidate();
    return receive(message, frame).finally(exchange.settle);
  }).catch(() => {
    if (child !== current || phase === "stopping") return;
    return shutdown(1);
  });
  current.stderr.pipe(process.stderr, { end: false });
  current.stdin.on("error", () => {});
  current.on("error", () => {
    void shutdown(1);
  });
  current.on("exit", () => {
    for (const pending of internal.values()) pending.reject(new Error("Claude exited"));
    internal.clear();
    if (child !== current || quitting || phase === "stopping") return;
    void shutdown(1);
  });
  await once(current, "spawn");
}
function request(request) {
  const id = "free-your-agents-internal-" + randomUUID();
  return new Promise((resolve, reject) => {
    // Resuming starts native Claude again, as slowly as a first launch.
    const timer = setTimeout(() => {
      internal.delete(id);
      reject(new Error("Claude handshake timed out"));
    }, startupTimeoutMs);
    internal.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    void write({ type: "control_request", request_id: id, request }).catch((error) => {
      const pending = internal.get(id);
      internal.delete(id);
      pending?.reject(error);
    });
  });
}
// Bridge shutdown only. A release drains instead (see release()).
async function stopNative() {
  const current = child;
  if (!current) return;
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, "exit");
    const signal = (name) => signalNative(current, name);
    current.stdin.end();
    const graceful = setTimeout(() => signal("SIGTERM"), 2000);
    const force = setTimeout(() => signal("SIGKILL"), 4000);
    try {
      await exited;
    } finally {
      clearTimeout(graceful);
      clearTimeout(force);
    }
  }
  if (child === current) child = null;
}
// Ending input is Claude's graceful shutdown: native finishes background work and
// turns it started itself (a task notification racing this release included),
// fails permission prompts it can no longer ask, and exits. Its own exit is the
// only completion; a drain is never cut short by a signal.
function drain(id, expectedGeneration) {
  const current = child;
  const exited = once(current, "exit");
  current.stdin.end();
  draining = {
    id,
    done: exited.then(async () => {
      if (child === current) child = null;
      // Requests native abandoned at exit no longer need the client's answer.
      for (const requestId of serverRequests.ids()) {
        abandoned.add(requestId);
        serverRequests.delete(requestId);
        await output({ type: "control_cancel_request", request_id: requestId });
      }
      phase = "released";
      outcomes.set(id, { generation: expectedGeneration, result: { status: "released" } });
      draining = null;
      reclaimer.released(() => phase === "released");
    }),
  };
  return draining.done;
}
const changesEvidence = (message) =>
  message.type === "result" ||
  message.type === "active_goal" ||
  message.type === "control_request" ||
  (message.type === "system" &&
    ["init", "session_state_changed", "background_tasks_changed"].includes(message.subtype));
const unavailable = () =>
  hooksDisabled
    ? "Claude SDK hooks are disabled for this invocation."
    : !initializeSeen
      ? "Claude process control is waiting for initialization."
      : !initializer
        ? "This conversation's setup is too large to restore after a stop."
        : !trackingComplete()
          ? "Protocol tracking capacity was exceeded. The process was left running."
          : !protocolSupported
            ? "This Claude operation could not be validated for process control."
            : null;
async function snapshot() {
  const memory = await sampleMemory(child?.pid);
  // A reservation does not release anything. Its eventual release still needs
  // a completed turn's inventory and all guards in release().
  const scheduleSupported = unavailable() === null;
  return {
    ...memory,
    controlVersion: 1,
    connectionId: process.env.RUNTIME_PROXY_CONNECTION_ID ?? null,
    agentId: process.env.RUNTIME_PROXY_AGENT_ID ?? null,
    phase,
    generation,
    proxyPid: process.pid,
    nativePid: child?.pid ?? null,
    spawns,
    activeTurns: activeUsers,
    unfinishedGoals: goalState === "unfinished" ? 1 : 0,
    pendingRequests: forwarded.size,
    pendingServerRequests: serverRequests.size,
    backgroundTasks,
    sessionCrons: inventory?.crons ?? null,
    nativeState,
    sessionId,
    providerVersion: version,
    cacheBytes: reads.stats().bytes,
    cacheByteLimit: reads.stats().maxBytes,
    scheduleSupported,
    releaseSupported: scheduleSupported && inventory !== null && goalState !== "unknown",
    unavailableReason:
      unavailable() ?? "Waiting for a safe stopping point. You can schedule a stop.",
  };
}
async function release(id, expectedGeneration) {
  if (phase === "released") return { status: "absent" };
  if (expectedGeneration !== generation) return { status: "generation-changed" };
  if (phase === "stopping") return { status: "stopping" };
  const reason = unavailable();
  if (reason) return { status: initializeSeen ? "unsupported" : "busy", reason };
  if (phase !== "running" || !sessionId) return { status: "busy", reason: "Not initialized" };
  if (!inventory) return { status: "busy", reason: "Waiting for Claude to finish a turn" };
  if (goalState === "unknown")
    return { status: "busy", reason: "Claude reported an unreadable goal state" };
  const checkpoint = session.control({ op: "checkpoint" });
  const inspected = inventory;
  const historySaved =
    typeof inspected.transcript === "string" &&
    !!(await stat(inspected.transcript).catch(() => null))?.size;
  // Answered client input plus authoritative idle orders this decision after
  // everything the client sent; the checkpoint fences anything since.
  const verdict = session.control({
    op: "release",
    checkpoint,
    evidence: {
      protocolSupported,
      trackingComplete: trackingComplete(),
      inventoryComplete: true,
      pendingWork: activeUsers + forwarded.size + serverRequests.size,
      subjects: [
        {
          execution:
            nativeState === "idle"
              ? "settled"
              : nativeState === "unknown"
                ? "unknown"
                : "active",
          goal: goalState,
          background: backgroundTasks ? "present" : "none",
          scheduled: inspected.crons ? "present" : "none",
        },
      ],
      resumeDurable: historySaved,
      stable: inventory === inspected,
    },
  });
  if (verdict.status !== "safe") return verdict;
  phase = "stopping";
  const done = drain(id, expectedGeneration);
  // Usually native exits at once. A longer drain reports "stopping"; the
  // scheduler confirms with the same ID until native has exited.
  const exited = await Promise.race([
    done.then(() => true),
    new Promise((resolve) => setTimeout(resolve, 1000, false)),
  ]);
  return { status: exited ? "released" : "stopping" };
}
async function wake() {
  if (phase !== "released") return;
  phase = "starting";
  await launch(true);
  await request(attachHook(initializer));
  for (const value of settings) await request(value);
  phase = "running";
}
async function incoming(message, frame) {
  // Input arriving during a drain is delivered to the resumed session.
  if (draining) await draining.done;
  if (message.type === "user") {
    if (phase === "released") await wake();
    activeUsers++;
  }
  if (message.type === "control_request") {
    const value = message.request;
    if (phase === "released") {
      if (readTypes.has(value?.subtype) && reads.has(JSON.stringify(value))) {
        await reply(message.request_id, reads.get(JSON.stringify(value)));
        return;
      }
      if (value?.subtype === "interrupt") {
        await reply(message.request_id);
        return;
      }
      await reply(
        message.request_id,
        {},
        "Runtime is stopped; send a message to resume before this operation.",
      );
      return;
    }
    // The client's initialization is forwarded exactly once, carrying our Stop
    // hook in the same handshake. Whether native runs it is proven by use: no
    // completed-turn inventory, no release. A setup too large to keep for a
    // resume passes through unchanged and disables release for this session.
    if (value?.subtype === "initialize") {
      initializeSeen = true;
      initializer =
        Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024 ? structuredClone(value) : null;
      if (initializer) {
        message = { ...message, request: attachHook(value) };
        frame = undefined;
      }
    }
    forwarded.set(message.request_id, value);
  }
  if (message.type === "control_response" || message.type === "control_cancel_request") {
    const id = message.response?.request_id ?? message.request_id;
    if (abandoned.delete(id)) return;
    serverRequests.delete(id);
  }
  await write(message, frame);
}
async function shutdown(code = 0) {
  if (quitting) return;
  quitting = true;
  await stopNative();
  await closeControl();
  await releaseLease();
  process.exit(code);
}
closeControl = await listenControl({
  path: process.env.RUNTIME_PROXY_SOCKET,
  token: process.env.RUNTIME_PROXY_TOKEN,
  handle: (message) =>
    message.op === "snapshot"
      ? snapshot()
      : // A drain holds the queue; confirming it must not wait behind it.
        draining && message.expectedGeneration === generation
        ? { status: "stopping" }
        : enqueue(async () => {
          const previous = outcomes.get(message.id);
          if (previous) {
            if (previous.generation !== message.expectedGeneration)
              throw new Error("Control request reused for another generation");
            return previous.result;
          }
          const result = await release(message.id, message.expectedGeneration);
          if (!["busy", "unsupported", "stopping"].includes(result.status))
            outcomes.set(message.id, { generation: message.expectedGeneration, result });
          if (outcomes.size > 128) outcomes.delete(outcomes.keys().next().value);
          return result;
        }),
});
await launch();
phase = "running";
void pumpJsonLines(process.stdin, async (message, frame) => {
  reclaimer.note(frame);
  const admission = session.exchange("client", message);
  await enqueue(async () => {
    admission.settle();
    try {
      await incoming(message, frame);
    } catch {
      await shutdown(1);
    }
  });
}).then(
  () => shutdown(),
  () => shutdown(1),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void shutdown();
  });
