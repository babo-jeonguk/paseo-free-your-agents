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
// ownership adapter, scheduler, safety hook, and local transport are exercised.
const peer = `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [root, version, observerMode] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let hook, finishing = false, background = true;
appendFileSync(root + '/spawns', process.pid + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'set_model') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      writeFileSync(root + '/setting-processed', 'yes');
      return;
    }
    hook = message.request.hooks?.Stop?.at(-1)?.hookCallbackIds?.[0];
    if (observerMode === 'exit-hooks' && hook) process.exit(0);
    if (observerMode === 'malformed-hooks' && hook) {
      process.stdout.write('not-json\\n');
      return;
    }
    if (observerMode === 'silent-hooks' && hook) return;
    if (observerMode === 'reject-hooks' && hook) {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'hooks are unsupported' } });
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (observerMode === 'exit-after-response' && hook) process.exit(0);
    emit({ type: 'system', subtype: 'init', session_id: 'fixture-session', claude_code_version: version });
    if (observerMode === 'malformed-goal')
      emit({ type: 'active_goal', session_id: 'fixture-session' });
    else if (observerMode !== 'missing-goal')
      emit({ type: 'active_goal', value: null, session_id: 'fixture-session' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  }
  if (message.type === 'user') {
    emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    writeFileSync(root + '/started', 'yes');
  }
  if (message.type === 'control_response' && message.response.request_id === 'stop-hook') {
    emit({ type: 'result', subtype: 'success', session_id: 'fixture-session' });
    emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  }
}).on('close', () => process.exit(0));
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
    ["2.1.301", false, "reject-hooks"],
    ["2.1.301", false, "silent-hooks"],
    ["2.1.301", false, "exit-hooks"],
    ["2.1.301", false, "exit-after-response"],
    ["2.1.301", false, "malformed-hooks"],
    ["2.1.301", false, "oversized-initialize"],
    ["2.1.301", false, "accept-hooks"],
    ["2.1.301", false, "stale-safety"],
    ["2.1.301", false, "malformed-goal"],
    ["2.1.301", false, "missing-goal"],
  ] as const) {
    await Promise.all(
      ["started", "finish", "background-done", "transcript", "setting-processed", "spawns"].map((name) =>
        rm(join(root, name), { force: true }),
      ),
    );
    const bridge = spawn(process.execPath, [fileURLToPath(new URL("./runtime/claude.mjs", import.meta.url)), process.execPath, script, root, version, observerMode, ...(disabled ? ["--bare"] : [])], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env, RUNTIME_PROXY_FIXTURE: "1", RUNTIME_PROXY_NEGOTIATION_TIMEOUT_MS: "1000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    bridge.stdout.resume();
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
    await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean).catch(
      (error) => {
        throw new Error(`${observerMode}: ${error instanceof Error ? error.message : String(error)}\n${stderr}`);
      },
    );
    const [runtime] = await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "working");
    const input = { agentId: "a", expectedGeneration: runtime!.generation, expectedStopId: null, action: "schedule" as const, hours: 0.25 };
    if (
      disabled ||
      ["reject-hooks", "silent-hooks", "exit-hooks", "exit-after-response", "malformed-hooks", "oversized-initialize"].includes(observerMode)
    ) {
      if (["exit-after-response", "oversized-initialize"].includes(observerMode)) {
        const spawns = (await readFile(join(root, "spawns"), "utf8")).trim().split("\n");
        assert.equal(spawns.length, 2, "unusable observer initialization must replace its child");
      }
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
    if (["missing-goal", "malformed-goal"].includes(observerMode)) {
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
    if (observerMode === "stale-safety") {
      bridge.stdin.write(JSON.stringify({
        type: "control_request",
        request_id: "set-model",
        request: { subtype: "set_model", model: "fixture-model" },
      }) + "\n");
      await waitFor(
        () => readFile(join(root, "setting-processed"), "utf8").catch(() => ""),
        Boolean,
      );
      await control.tick();
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
    await control.tick();
    const stopped = (await control.list()).rows[0]!;
    assert.equal(stopped.runtime.presence, "absent", JSON.stringify(stopped));
    assert.equal(stopped.stop, null);
    assert.equal(stopped.stopped, true);
    bridge.stdin.end();
    await exited;
    assert.equal(bridge.exitCode, 0, stderr);
  }
});
