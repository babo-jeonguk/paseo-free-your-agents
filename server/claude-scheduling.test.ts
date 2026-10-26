import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createControl } from "./control";
import { createFileStore } from "./store";
import { createProxyRuntime } from "./proxy-runtime";

// Deterministic protocol peer, not native Claude evidence. The actual bridge,
// ownership adapter, scheduler, Stop hook inventory, and local transport are exercised.
const peer = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [root, version, observerMode] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let hook, initialized = false, finishing = false, background = true;
appendFileSync(root + '/spawns', process.pid + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'set_model') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      writeFileSync(root + '/setting-processed', 'yes');
      return;
    }
    if (message.request.subtype === 'cancel_async_message') {
      writeFileSync(root + '/native-cancel', 'yes');
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { cancelled: false } } });
      return;
    }
    // Like native Claude, an interrupted turn ends without a Stop hook.
    if (message.request.subtype === 'interrupt') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      emit({ type: 'result', subtype: 'error_during_execution', session_id: 'fixture-session' });
      emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      return;
    }
    hook = message.request.hooks?.Stop?.at(-1)?.hookCallbackIds?.[0];
    const answer = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    // A loaded machine can take several seconds to resume a session.
    if (observerMode === 'slow-wake' && process.argv.includes('--resume')) setTimeout(answer, 6000);
    else answer();
  }
  if (message.type === 'user' && observerMode === 'exit-during-turn' && hook) process.exit(1);
  // Like native Claude, init arrives only once the first user message starts a query.
  if (message.type === 'user' && !initialized) {
    initialized = true;
    emit({ type: 'system', subtype: 'init', claude_code_version: version,
      ...(observerMode === 'missing-session' ? {} : { session_id: 'fixture-session' }) });
    // Native Claude sends active_goal only from its /goal Stop hook.
    if (observerMode === 'cleared-goal')
      emit({ type: 'active_goal', session_id: 'fixture-session' });
    else if (observerMode === 'unfinished-goal')
      emit({ type: 'active_goal', value: { condition: 'fixture', iterations: 1 }, session_id: 'fixture-session' });
    else if (observerMode === 'malformed-goal')
      emit({ type: 'active_goal', value: 'fixture', session_id: 'fixture-session' });
  }
  if (message.type === 'user') {
    emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    writeFileSync(root + '/started', 'yes');
  }
  if (message.type === 'control_response' && message.response.request_id === 'stop-hook') {
    emit({ type: 'result', subtype: 'success', session_id: 'fixture-session' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  }
}).on('close', () => {
  // Native Claude treats end of input as a graceful shutdown: it finishes work it
  // started itself, here a notification turn longer than any kill deadline.
  if (!observerMode.startsWith('drain-')) process.exit(0);
  emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  if (observerMode === 'drain-turn') {
    emit({ type: 'control_request', request_id: 'drain-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
    // Native withdraws a request of its own; a late answer to it has no taker.
    emit({ type: 'control_request', request_id: 'self-cancelled', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
    emit({ type: 'control_cancel_request', request_id: 'self-cancelled' });
  }
  // Output the bridge cannot read, then more than a pipe holds: a pipe nobody
  // reads would block this process forever.
  if (observerMode === 'drain-malformed') {
    process.stdout.write('not-json\\n');
    for (let line = 0; line < 512; line++) emit({ type: 'stream_event', padding: 'x'.repeat(1024) });
  }
  // Like native Claude, SIGINT ends the turn being finished; with input closed it then exits.
  process.on('SIGINT', () => {
    writeFileSync(root + '/sigint', 'yes');
    emit({ type: 'result', subtype: 'error_during_execution', session_id: 'fixture-session' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    process.exit(0);
  });
  setTimeout(() => {
    writeFileSync(root + '/drained', 'yes');
    emit({ type: 'result', subtype: 'success', session_id: 'fixture-session' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    // A helper sharing stdout writes after native has exited: exit alone does not
    // mean all of native's output has arrived. Windows does not share the pipe
    // with such a helper, so there output cannot outlive the exit.
    if (observerMode === 'drain-turn' && process.platform !== 'win32')
      spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(' + JSON.stringify(JSON.stringify({ type: 'control_request', request_id: 'late-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\\n') + '), 300)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    process.exit(0);
  }, 3000);
});
setInterval(() => {
  if (!finishing && existsSync(root + '/finish')) {
    finishing = true;
    writeFileSync(root + '/transcript', 'saved fixture history');
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}] });
    emit({ type: 'control_request', request_id: 'stop-hook', request: {
      subtype: 'hook_callback', callback_id: hook,
      input: { hook_event_name: 'Stop', background_tasks: [{}], session_crons: [], transcript_path: root + '/transcript' }
    }});
  }
  if (finishing && background && existsSync(root + '/background-done')) {
    background = false;
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  }
}, 10);
`;

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Claude bridge fixture");
}

test("Claude bridge accepts reservations during its first turn and protects foreground and background work", {
  skip: process.platform !== "linux" && process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fya-claude-schedule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "peer.mjs");
  await writeFile(script, peer);
  const adapter = createProxyRuntime({
    directory: join(root, "runtime"),
    metadata: async (ids) => ids.map((agentId) => ({ agentId, title: "Fixture", provider: "claude", workspace: "Fixture" })),
  });
  const env = await adapter.prepareSession({ agentId: "a", provider: "claude", purpose: "interactive" });
  let clock = 100_000;
  const control = createControl(createFileStore(join(root, "state.json")), () => clock);
  control.attach(adapter.api);
  const epoch = await control.register("fixture-window");
  await control.publish({ ownerId: "fixture-window", epoch, revision: 0, agentIds: ["a"] });
  for (const [version, disabled, observerMode] of [
    ["9.9.9", false, "accept-hooks"],
    ["2.1.301", true, "accept-hooks"],
    ["2.1.301", false, "exit-during-turn"],
    ["2.1.301", false, "oversized-initialize"],
    ["2.1.301", false, "accept-hooks"],
    ["2.1.301", false, "setting-after-turn"],
    ["2.1.301", false, "interrupt-after-turn"],
    ["2.1.301", false, "drain-turn"],
    ["2.1.301", false, "drain-interrupt"],
    ["2.1.301", false, "drain-withdraw"],
    ["2.1.301", false, "drain-flood"],
    ["2.1.301", false, "cleared-goal"],
    ["2.1.301", false, "unfinished-goal"],
    ["2.1.301", false, "malformed-goal"],
    ["2.1.301", false, "missing-session"],
    ["2.1.301", false, "slow-wake"],
    ["2.1.301", false, "drain-malformed"],
  ] as const) {
    await Promise.all(
      ["started", "finish", "background-done", "transcript", "setting-processed", "spawns", "drained", "sigint", "native-cancel"].map((name) =>
        rm(join(root, name), { force: true }),
      ),
    );
    const bridge = spawn(process.execPath, [fileURLToPath(new URL("./runtime/claude.mjs", import.meta.url)), process.execPath, script, root, version, observerMode, ...(disabled ? ["--bare"] : [])], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env, RUNTIME_PROXY_FIXTURE: "1", RUNTIME_PROXY_STARTUP_TIMEOUT_MS: observerMode === "slow-wake" ? "10000" : "1000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "", stdout = "";
    bridge.stdout.on("data", (chunk) => { stdout += chunk; });
    bridge.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(bridge, "exit");
    t.after(async () => {
      if (bridge.exitCode === null && bridge.signalCode === null) {
        bridge.stdin.end();
        const timer = setTimeout(() => bridge.kill("SIGKILL"), 6000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    });
    bridge.stdin.write(JSON.stringify({
      type: "control_request",
      request_id: "init",
      request: {
        subtype: "initialize",
        ...(observerMode === "oversized-initialize" ? { padding: "x".repeat(65 * 1024) } : {}),
      },
    }) + "\n");
    bridge.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
    if (observerMode === "exit-during-turn") {
      // Accepted hooks make the child the session: a crash is not replayed.
      await exited;
      assert.notEqual(bridge.exitCode, 0, stderr);
      const spawns = (await readFile(join(root, "spawns"), "utf8")).trim().split("\n");
      assert.equal(spawns.length, 1, "a running turn is never replayed into a replacement");
      continue;
    }
    await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean).catch(
      (error) => {
        throw new Error(`${observerMode}: ${error instanceof Error ? error.message : String(error)}\n${stderr}`);
      },
    );
    const [runtime] = await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "working");
    // A mode whose bridge exited leaves its stop unconfirmed; this new process makes it obsolete.
    await control.tick();
    const input = { agentId: "a", expectedGeneration: runtime!.generation, expectedStopId: null, action: "schedule" as const, hours: 0.25 };
    if (disabled || ["oversized-initialize", "missing-session"].includes(observerMode)) {
      // Initialization is forwarded exactly once and native is never replaced.
      const spawns = (await readFile(join(root, "spawns"), "utf8")).trim().split("\n");
      assert.equal(spawns.length, 1, observerMode);
      const reason = disabled ? /hooks are disabled/ : observerMode === "oversized-initialize" ? /too large to restore/ : /could not be validated/;
      assert.match(runtime!.unavailableReason ?? "", reason, observerMode);
      assert.equal(runtime!.schedulable, false);
      assert.equal((await control.change(input)).changed, false);
      bridge.stdin.end();
      await exited;
      continue;
    }
    assert.equal(runtime!.releasable, false, "No Stop hook has run yet");
    assert.equal(runtime!.schedulable, true, JSON.stringify({ observerMode, runtime }));
    const scheduledAt = clock;
    const scheduled = await control.change(input);
    assert.equal(scheduled.changed, true, JSON.stringify({ observerMode, scheduled, runtime }));
    const saved = (await control.list()).rows[0]!.stop!;
    assert.equal(saved.dueAt, scheduledAt + 900_000);
    clock = saved.dueAt;
    await control.publish({
      ownerId: "fixture-window",
      epoch,
      revision: 0,
      agentIds: ["a"],
    });
    await control.tick();
    assert.equal((await control.list()).rows[0]!.stop!.state, "deferred");
    assert.equal((await adapter.api.snapshot({ agentIds: ["a"] }))[0]!.presence, "running");
    await writeFile(join(root, "finish"), "yes");
    await waitFor(
      () => adapter.api.snapshot({ agentIds: ["a"] }),
      ([value]) => value?.activity === "background",
    ).catch(async (error) => {
      const snapshot = await adapter.api.snapshot({ agentIds: ["a"] });
      throw new Error(`${observerMode}: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify(snapshot)} ${stderr}`);
    });
    await control.tick();
    if (["unfinished-goal", "malformed-goal"].includes(observerMode)) {
      const protectedRow = (await control.list()).rows[0]!;
      assert.equal(protectedRow.runtime.presence, "running");
      assert.equal(protectedRow.stop?.state, "deferred");
      const cancelled = await control.change({
        agentId: "a",
        expectedGeneration: protectedRow.runtime.generation,
        expectedStopId: protectedRow.stop!.id,
        action: "cancel",
      });
      assert.equal(cancelled.changed, true);
      bridge.stdin.end();
      await exited;
      continue;
    }
    assert.equal((await control.list()).rows[0]!.stop!.state, "deferred");
    await writeFile(join(root, "background-done"), "yes");
    await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "idle");
    if (observerMode === "setting-after-turn") {
      // A setting is not work: the completed turn's inventory still applies.
      bridge.stdin.write(JSON.stringify({
        type: "control_request",
        request_id: "set-model",
        request: { subtype: "set_model", model: "fixture-model" },
      }) + "\n");
      await waitFor(() => readFile(join(root, "setting-processed"), "utf8").catch(() => ""), Boolean);
      await rm(join(root, "setting-processed"));
    }
    if (observerMode === "interrupt-after-turn") {
      // An interrupted turn runs no Stop hook; the last completed turn's
      // scheduled-work inventory still applies once native is idle again.
      await rm(join(root, "started"));
      bridge.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "again" } }) + "\n");
      await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean);
      await control.tick();
      assert.equal((await control.list()).rows[0]!.stop!.state, "deferred", "A running turn is protected");
      bridge.stdin.write(JSON.stringify({ type: "control_request", request_id: "interrupt", request: { subtype: "interrupt" } }) + "\n");
      await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.releasable === true);
    }
    if (observerMode === "drain-turn") {
      // The drain's permission request is answered only after native has exited.
      const answered = waitFor(async () => stdout, (value) => value.includes("self-cancelled")).then(() => {
        for (const id of ["drain-permission", "self-cancelled"])
          bridge.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } }) + "\n");
      });
      for (let round = 0; round < 50 && (await control.list()).rows[0]!.stop; round++) {
        await control.tick();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await answered;
      assert.equal(await readFile(join(root, "drained"), "utf8"), "yes", "Native finished its own work");
      await waitFor(async () => stdout, (value) => value.includes('"control_cancel_request","request_id":"drain-permission"'));
      if (process.platform !== "win32")
        await waitFor(async () => stdout, (value) => value.includes('"control_cancel_request","request_id":"late-permission"'));
    } else if (observerMode.startsWith("drain-")) {
      await control.tick();
      assert.equal((await control.list()).rows[0]!.stop?.state, "stopping", "Native is finishing its own turn");
      if (observerMode === "drain-malformed") {
        // A stream the bridge cannot read ends it, draining or not; it never stalls native.
        await waitFor(async () => bridge.exitCode ?? bridge.signalCode, (value) => value !== null);
        assert.notEqual(bridge.exitCode, 0, stderr);
        continue;
      }
      // Input during a drain waits for the resumed session, which answers it
      // itself. The user's stop gesture (a withdrawal or an interrupt), or more
      // input than the queue holds, ends the turn native is finishing.
      await rm(join(root, "started"));
      const uuid = "33333333-3333-4333-8333-333333333333";
      if (observerMode === "drain-flood") {
        for (let frame = 0; frame < 300; frame++)
          bridge.stdin.write(JSON.stringify({ type: "control_request", request_id: "flood-" + frame, request: { subtype: "set_model", model: "fixture" } }) + "\n");
        bridge.stdin.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: "after flood" } }) + "\n");
      } else {
        bridge.stdin.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: "during drain" } }) + "\n");
        bridge.stdin.write(JSON.stringify(observerMode === "drain-withdraw"
          ? { type: "control_request", request_id: "stop", request: { subtype: "cancel_async_message", message_uuid: uuid } }
          : { type: "control_request", request_id: "stop", request: { subtype: "interrupt" } }) + "\n");
      }
      await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean);
      assert.equal(await readFile(join(root, "drained"), "utf8").catch(() => "cut short"), "cut short", "The stop ended native's turn early");
      if (process.platform !== "win32")
        assert.equal(await readFile(join(root, "sigint"), "utf8"), "yes", "SIGINT ended the turn");
      assert.equal((await readFile(join(root, "spawns"), "utf8")).trim().split("\n").length, 2);
      if (observerMode !== "drain-flood") {
        await waitFor(async () => stdout, (value) => value.includes('"request_id":"stop"'));
        if (observerMode === "drain-withdraw")
          assert.equal(await readFile(join(root, "native-cancel"), "utf8"), "yes", "The resumed native answered the withdrawal");
      }
      // The scheduler settles the stop against the resumed process.
      for (let round = 0; round < 20 && (await control.list()).rows[0]!.stop; round++) await control.tick();
      assert.equal((await control.list()).rows[0]!.stop, null);
      bridge.stdin.end();
      await exited;
      assert.equal(bridge.exitCode, 0, stderr);
      continue;
    } else await control.tick();
    const stopped = (await control.list()).rows[0]!;
    assert.equal(stopped.runtime.presence, "absent", JSON.stringify(stopped));
    assert.equal(stopped.stop, null);
    assert.equal(stopped.stopped, true);
    if (observerMode === "slow-wake" || observerMode === "setting-after-turn") {
      await rm(join(root, "started"), { force: true });
      // The resumed turn is interrupted before any Stop hook can run.
      await rm(join(root, "finish"), { force: true });
      bridge.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "resume" } }) + "\n");
      await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean);
      assert.equal((await adapter.api.snapshot({ agentIds: ["a"] }))[0]!.presence, "running", stderr);
      if (observerMode === "setting-after-turn")
        assert.equal(await readFile(join(root, "setting-processed"), "utf8"), "yes", "Resume replays the setting");
      // Scheduled wakeups belong to the session: an interrupted first turn after
      // resuming still has the inventory the release was decided on.
      bridge.stdin.write(JSON.stringify({ type: "control_request", request_id: "resume-interrupt", request: { subtype: "interrupt" } }) + "\n");
      await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.releasable === true && value.activity === "idle");
    }
    bridge.stdin.end();
    await exited;
    assert.equal(bridge.exitCode, 0, stderr);
  }
});
