// Provider compatibility: a Claude stdio facade. Not published or enabled on the host.
// Uses the CLI's SDK Stop hook to observe background work/session crons. Never
// reinitialize a running CLI to probe it: that can cancel existing hook requests.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { listenControl } from "./control.mjs";
import { claudeVersions } from "./versions.mjs";
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
const launchValidated =
  process.env.RUNTIME_PROXY_FIXTURE === "1" || process.env.RUNTIME_PROXY_CLAUDE_VALIDATED === "1";
const baseHooksDisabled =
  !launchValidated ||
  originalArgs.includes("--bare") ||
  (process.env.RUNTIME_PROXY_FIXTURE !== "1" && !!process.env.CLAUDE_CODE_SIMPLE);
let hooksDisabled = baseHooksDisabled;
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
let initializer = null,
  sessionId = null,
  version = null,
  nativeState = "unknown",
  safety = null;
let activeUsers = 0,
  admissions = 0,
  activeGoal = false,
  backgroundTasks = 0,
  protocolSupported = true;
let closeControl = async () => {};
const output = (value) => writeJsonLine(process.stdout, value);
// Pass the source frame when the message is forwarded unchanged.
function write(value, frame) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
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
      safety =
        input?.hook_event_name === "Stop" &&
        Array.isArray(input.background_tasks) &&
        Array.isArray(input.session_crons)
          ? {
              backgroundTasks: input.background_tasks.length,
              crons: input.session_crons.length,
              transcript: input.transcript_path,
            }
          : null;
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
  if (message.type === "control_cancel_request") serverRequests.delete(message.request_id);
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
        if (
          request.subtype === "apply_flag_settings" &&
          ["disableAllHooks", "allowManagedHooksOnly", "hooks"].some((name) =>
            Object.hasOwn(request.settings ?? {}, name),
          )
        ) {
          safety = null;
          hooksDisabled =
            baseHooksDisabled ||
            request.settings?.disableAllHooks === true ||
            request.settings?.allowManagedHooksOnly === true;
        }
      }
    }
  }
  if (message.type === "system" && message.subtype === "init") {
    version = message.claude_code_version;
    if (sessionId && sessionId !== message.session_id)
      throw new Error("Claude session identity changed");
    sessionId = message.session_id;
  }
  if (message.type === "system" && message.subtype === "session_state_changed")
    nativeState = message.state;
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    if (!Array.isArray(message.tasks)) protocolSupported = false;
    else {
      backgroundTasks = message.tasks.length;
      // The authoritative level event supersedes an earlier Stop-hook count.
      // Otherwise a task completing without another root Stop wedges release.
      if (safety) safety = { ...safety, backgroundTasks };
    }
  }
  if (message.type === "active_goal") activeGoal = message.value != null;
  if (message.type === "result") activeUsers = Math.max(0, activeUsers - 1);
  await (frame ? writeProtocolBytes(process.stdout, frame) : output(message));
}
async function launch(resume = false) {
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
  nativeState = "unknown";
  safety = null;
  void pumpJsonLines(current.stdout, (message, frame) => {
    reclaimer.note(frame);
    return receive(message, frame);
  }).catch(() => shutdown(1));
  current.stderr.pipe(process.stderr, { end: false });
  current.stdin.on("error", () => {});
  current.on("error", () => {
    void shutdown(1);
  });
  current.on("exit", () => {
    for (const pending of internal.values()) pending.reject(new Error("Claude exited"));
    internal.clear();
    if (child === current && phase !== "stopping" && !quitting) void shutdown(1);
  });
  await once(current, "spawn");
}
function request(request) {
  const id = "free-your-agents-internal-" + randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      internal.delete(id);
      reject(new Error("Claude handshake timed out"));
    }, 5000);
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
async function snapshot() {
  const memory = await sampleMemory(child?.pid);
  // A reservation does not release anything. Its eventual release still needs
  // this turn's complete safety snapshot and all guards in release().
  const scheduleSupported =
    !hooksDisabled &&
    protocolSupported &&
    trackingComplete() &&
    claudeVersions.includes(version);
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
    unfinishedGoals: activeGoal ? 1 : 0,
    pendingRequests: forwarded.size,
    pendingServerRequests: serverRequests.size,
    backgroundTasks,
    hookBackgroundTasks: safety?.backgroundTasks ?? null,
    sessionCrons: safety?.crons ?? null,
    nativeState,
    sessionId,
    cacheBytes: reads.stats().bytes,
    cacheByteLimit: reads.stats().maxBytes,
    scheduleSupported,
    releaseSupported: scheduleSupported && safety !== null,
    unavailableReason: hooksDisabled
      ? launchValidated
        ? "Claude SDK hooks are disabled for this invocation."
        : "This Claude launch command or CLI version has not been validated for process control."
      : !trackingComplete()
      ? "Protocol tracking capacity was exceeded. The process was left running."
      : !protocolSupported || (version && !claudeVersions.includes(version))
      ? "This Claude version or operation has not been validated for process control."
      : scheduleSupported
      ? "Waiting for a safe stopping point. You can schedule a stop."
      : "Claude process control is waiting for initialization.",
  };
}
async function release(expectedGeneration) {
  if (phase === "released") return { status: "absent" };
  if (expectedGeneration !== generation) return { status: "generation-changed" };
  if (hooksDisabled)
    return { status: "unsupported", reason: "Claude SDK hooks are disabled for this invocation." };
  if (phase !== "running" || !initializer || !sessionId)
    return { status: "busy", reason: "Not initialized" };
  if (!protocolSupported || !claudeVersions.includes(version))
    return { status: "unsupported", reason: "Claude protocol is not validated" };
  if (!trackingComplete())
    return {
      status: "unsupported",
      reason: "Protocol tracking capacity was exceeded. The process was left running.",
    };
  if (!safety) return { status: "busy", reason: "Waiting for a complete Claude safety snapshot" };
  if (
    nativeState !== "idle" ||
    activeUsers ||
    admissions ||
    forwarded.size ||
    serverRequests.size ||
    activeGoal ||
    backgroundTasks ||
    safety.backgroundTasks ||
    safety.crons
  )
    return { status: "busy", reason: "Claude work, permissions, or scheduled activity is pending" };
  if (
    typeof safety.transcript !== "string" ||
    !(await stat(safety.transcript).catch(() => null))?.size
  )
    return { status: "busy", reason: "Claude history is not saved" };
  // stat yielded: recheck host admissions and native activity before stopping.
  if (!trackingComplete())
    return {
      status: "unsupported",
      reason:
        "Protocol tracking capacity was exceeded during inspection. The process was left running.",
    };
  if (
    !safety ||
    safety.backgroundTasks ||
    safety.crons ||
    hooksDisabled ||
    !protocolSupported ||
    nativeState !== "idle" ||
    activeUsers ||
    admissions ||
    forwarded.size ||
    serverRequests.size ||
    activeGoal ||
    backgroundTasks
  )
    return { status: "busy", reason: "New work arrived" };
  phase = "stopping";
  await stopNative();
  phase = "released";
  reclaimer.released(() => phase === "released");
  return { status: "released" };
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
  if (message.type === "user") {
    if (phase === "released") await wake();
    activeUsers++;
    safety = null;
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
    if (value?.subtype === "initialize") {
      if (Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024)
        initializer = structuredClone(value);
      else protocolSupported = false;
      message = { ...message, request: attachHook(value) };
      frame = undefined;
    }
    forwarded.set(message.request_id, value);
  }
  if (message.type === "control_response" || message.type === "control_cancel_request")
    serverRequests.delete(message.response?.request_id ?? message.request_id);
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
      : enqueue(async () => {
          const previous = outcomes.get(message.id);
          if (previous) {
            if (previous.generation !== message.expectedGeneration)
              throw new Error("Control request reused for another generation");
            return previous.result;
          }
          const result = await release(message.expectedGeneration);
          if (!["busy", "unsupported"].includes(result.status))
            outcomes.set(message.id, { generation: message.expectedGeneration, result });
          if (outcomes.size > 128) outcomes.delete(outcomes.keys().next().value);
          return result;
        }),
});
await launch();
phase = "running";
void pumpJsonLines(process.stdin, async (message, frame) => {
  reclaimer.note(frame);
  const user = message.type === "user";
  if (user) admissions++;
  await enqueue(async () => {
    if (user) admissions--;
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
