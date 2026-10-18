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
import { existsSync, writeFileSync } from 'node:fs';
const [root, version] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let hook, finishing = false, background = true;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    hook = message.request.hooks?.Stop?.at(-1)?.hookCallbackIds?.[0];
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    emit({ type: 'system', subtype: 'init', session_id: 'fixture-session', claude_code_version: version });
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
  for (const [version, disabled] of [["9.9.9", false], ["2.1.301", true], ["2.1.301", false]] as const) {
    const bridge = spawn(process.execPath, [fileURLToPath(new URL("./runtime/claude.mjs", import.meta.url)), process.execPath, script, root, version, ...(disabled ? ["--bare"] : [])], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env, RUNTIME_PROXY_FIXTURE: "1" },
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
    bridge.stdin.write(JSON.stringify({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }) + "\n");
    bridge.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
    await waitFor(() => readFile(join(root, "started"), "utf8").catch(() => ""), Boolean);
    const [runtime] = await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "working");
    const input = { agentId: "a", expectedGeneration: runtime!.generation, expectedStopId: null, action: "schedule" as const, hours: 0.25 };
    if (version === "9.9.9" || disabled) {
      assert.equal(runtime!.schedulable, false);
      assert.equal((await control.change(input)).changed, false);
      bridge.stdin.end();
      await exited;
      await rm(join(root, "started"));
      continue;
    }
    assert.equal(runtime!.releasable, false, "No Stop hook has run yet");
    assert.equal(runtime!.schedulable, true);
    assert.equal((await control.change(input)).changed, true);
    const saved = (await control.list()).rows[0]!.stop!;
    assert.equal(saved.dueAt, 1_000_000);
    clock = saved.dueAt;
    await control.tick();
    assert.equal((await control.list()).rows[0]!.stop!.state, "deferred");
    assert.equal((await adapter.api.snapshot({ agentIds: ["a"] }))[0]!.presence, "running");
    await writeFile(join(root, "finish"), "yes");
    await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "background");
    await control.tick();
    assert.equal((await control.list()).rows[0]!.stop!.state, "deferred");
    await writeFile(join(root, "background-done"), "yes");
    await waitFor(() => adapter.api.snapshot({ agentIds: ["a"] }), ([value]) => value?.activity === "idle");
    await control.tick();
    const stopped = (await control.list()).rows[0]!;
    assert.equal(stopped.runtime.presence, "absent");
    assert.equal(stopped.stop, null);
    assert.equal(stopped.stopped, true);
    bridge.stdin.end();
    await exited;
    assert.equal(bridge.exitCode, 0, stderr);
  }
});
