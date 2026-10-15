import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, chmod, stat, readFile, readdir, unlink, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, dirname } from "node:path";
import { createProxyRuntime, type ProxyRecord } from "./proxy-runtime";
import { claimProxyConnection } from "./proxy-launch.mjs";
import { ownProxyLease } from "./proxy-lease.mjs";

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "proxy-runtime-test-"));
  const endpoints = new Set<string>();
  const connections = new Set<Socket>();
  const servers: ReturnType<typeof createServer>[] = [];
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    for (const endpoint of endpoints) await rm(endpoint, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    directory,
    metadata: async (ids: string[]) =>
      ids.map((agentId) => ({
        agentId,
        title: "Conversation",
        provider: agentId === "claude" ? "claude" : "codex",
        workspace: "workspace",
      })),
  };
  let adapter = createProxyRuntime(options);
  const requests: { op: string; id: string; expectedGeneration?: string }[] = [];
  async function peer(agentId = "a", provider: "codex" | "claude" = "codex") {
    const recipe = await adapter.prepareSession({
      agentId,
      provider,
      purpose: "interactive",
    });
    const env = await claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!);
    const record: ProxyRecord = JSON.parse(
      await readFile(env.RUNTIME_PROXY_CONNECTION_FILE!, "utf8"),
    );
    endpoints.add(dirname(record.socketPath));
    const state = {
      controlVersion: 1,
      connectionId: record.connectionId,
      agentId,
      phase: "running",
      generation: randomUUID(),
      nativePid: process.pid,
      activeTurns: 0,
      pendingRequests: 0,
      pendingServerRequests: 0,
      unfinishedGoals: 0,
      releaseSupported: true,
      backgroundTasks: 0,
      sessionCrons: 0,
      unavailableReason: undefined as string | undefined,
    };
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        assert.equal(message.token, record.token);
        requests.push({
          op: message.op,
          id: message.id,
          expectedGeneration: message.expectedGeneration,
        });
        const result =
          message.op === "snapshot"
            ? state
            : message.expectedGeneration !== state.generation
            ? { status: "generation-changed" }
            : state.activeTurns || state.backgroundTasks || state.sessionCrons
            ? { status: "busy", reason: "Work in progress" }
            : { status: "released" };
        socket.end(JSON.stringify({ id: message.id, result }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(record.socketPath, resolve));
    await chmod(record.socketPath, 0o600);
    servers.push(server);
    return { env, record, state };
  }
  return {
    directory,
    adapter,
    peer,
    requests,
    reload: () => {
      adapter = createProxyRuntime(options);
      return adapter;
    },
  };
}

test(
  "preexisting processes are pending restart, never assumed stopped",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, requests } = await setup(t);
    const [runtime] = await adapter.api.snapshot({ agentIds: ["a"] });
    assert.equal(runtime!.presence, "unknown");
    assert.equal(runtime!.releasable, false);
    assert.equal(runtime!.generation, null);
    assert.equal(runtime!.controlStatus, "after-restart");
    assert.equal(
      (
        await adapter.api.releaseIfIdle({
          agentId: "a",
          expectedGeneration: "old",
          requestId: "stop",
        })
      ).status,
      "unsupported",
    );
    assert.deepEqual(requests, []);
  },
);

test(
  "private records survive controller replacement without stopping or waking the provider",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, peer, reload, requests, directory } = await setup(t);
    const { env, record, state } = await peer();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(env.RUNTIME_PROXY_CONNECTION_FILE!)).mode & 0o777, 0o600);
    const [before] = await adapter.api.snapshot({ agentIds: ["a", "a"] });
    const [after] = await reload().api.snapshot({ agentIds: ["a"] });
    assert.deepEqual(after, before);
    assert.equal(before!.generation, record.connectionId + ":" + state.generation);
    assert.ok(requests.every((message) => message.op === "snapshot"));
    assert.ok(
      !JSON.stringify(before).includes(record.token),
      "Capabilities must not reach inventory DTOs",
    );
    state.phase = "released";
    state.nativePid = null as unknown as number;
    const [stopped] = await adapter.api.snapshot({ agentIds: ["a"] });
    assert.equal(stopped!.presence, "absent");
    assert.equal(stopped!.generation, null);
  },
);

test(
  "release checks conversation identity and passes generation and operation ID",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, peer, requests } = await setup(t);
    const { record, state } = await peer();
    const expectedGeneration = record.connectionId + ":" + state.generation;
    state.activeTurns = 1;
    const busy = await adapter.api.releaseIfIdle({
      agentId: "a",
      expectedGeneration,
      requestId: "policy",
    });
    assert.deepEqual(busy, { status: "busy", error: "Work in progress" });
    state.activeTurns = 0;
    assert.equal(
      (
        await adapter.api.releaseIfIdle({
          agentId: "a",
          expectedGeneration,
          requestId: "policy",
        })
      ).status,
      "released",
    );
    assert.deepEqual(
      requests.filter((request) => request.op === "release"),
      [
        { op: "release", id: "policy", expectedGeneration: state.generation },
        { op: "release", id: "policy", expectedGeneration: state.generation },
      ],
    );
    const count = requests.length;
    assert.equal(
      (
        await adapter.api.releaseIfIdle({
          agentId: "a",
          expectedGeneration: randomUUID() + ":" + state.generation,
          requestId: "stale",
        })
      ).status,
      "generation-changed",
    );
    assert.equal(requests.length, count);
    state.agentId = "another-conversation";
    await assert.rejects(
      adapter.api.releaseIfIdle({
        agentId: "a",
        expectedGeneration,
        requestId: "forged",
      }),
      /different conversation/,
    );
    assert.ok(!requests.some((request) => request.id === "forged"));
  },
);

test(
  "multiple and unreachable connections preserve uncertainty without picking a PID",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, peer, requests } = await setup(t);
    const first = await peer();
    await peer();
    const [duplicate] = await adapter.api.snapshot({ agentIds: ["a"] });
    assert.equal(duplicate!.releasable, false);
    assert.equal(duplicate!.presence, "unknown");
    assert.equal(
      (
        await adapter.api.releaseIfIdle({
          agentId: "a",
          expectedGeneration: first.record.connectionId + ":" + first.state.generation,
          requestId: "duplicate",
        })
      ).status,
      "unsupported",
    );
    assert.deepEqual(requests, []);
    const single = await peer("b");
    await unlink(single.record.socketPath);
    const [missing] = await adapter.api.snapshot({ agentIds: ["b"] });
    assert.equal(missing!.presence, "unknown");
    assert.equal(missing!.releasable, false);
  },
);

test(
  "unsafe connection records and endpoint permissions fail closed",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, peer, directory, requests } = await setup(t);
    const { env, record } = await peer();
    await chmod(record.socketPath, 0o666);
    assert.equal((await adapter.api.snapshot({ agentIds: ["a"] }))[0]!.presence, "unknown");
    assert.deepEqual(requests, []);
    await chmod(env.RUNTIME_PROXY_CONNECTION_FILE!, 0o644);
    await assert.rejects(adapter.api.snapshot({ agentIds: ["a"] }), /not private/);
    const contents = await readFile(env.RUNTIME_PROXY_CONNECTION_FILE!);
    const external = join(directory, "external.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(external, contents, { mode: 0o600 });
    await unlink(env.RUNTIME_PROXY_CONNECTION_FILE!);
    await symlink(external, env.RUNTIME_PROXY_CONNECTION_FILE!);
    await assert.rejects(adapter.api.snapshot({ agentIds: ["a"] }));
  },
);

test(
  "history and unsupported providers do not acquire a writer connection",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, directory } = await setup(t);
    assert.deepEqual(
      await adapter.prepareSession({
        agentId: "history",
        provider: "codex",
        purpose: "history",
      }),
      {},
    );
    assert.deepEqual(
      await adapter.prepareSession({
        agentId: "unsupported",
        provider: "copilot",
        purpose: "interactive",
      }),
      {},
    );
    assert.deepEqual(await readdir(directory), []);
  },
);

test(
  "one captured launch recipe allocates fresh identities and cannot retarget another directory",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, directory } = await setup(t);
    const recipe = await adapter.prepareSession({
      agentId: "a",
      provider: "codex",
      purpose: "interactive",
    });
    const reopened = await adapter.prepareSession({
      agentId: "a",
      provider: "codex",
      purpose: "interactive",
    });
    assert.equal(reopened.RUNTIME_PROXY_RECIPE_FILE, recipe.RUNTIME_PROXY_RECIPE_FILE);
    assert.deepEqual(await readdir(join(directory, "recipes")), [
      basename(recipe.RUNTIME_PROXY_RECIPE_FILE!),
    ]);
    const first = await claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!);
    const cleanups = [first];
    try {
      await unlink(first.RUNTIME_PROXY_CONNECTION_FILE!);
      const second = await claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!);
      cleanups.push(second);
      assert.notEqual(first.RUNTIME_PROXY_CONNECTION_ID, second.RUNTIME_PROXY_CONNECTION_ID);
      assert.notEqual(first.RUNTIME_PROXY_TOKEN, second.RUNTIME_PROXY_TOKEN);
      assert.notEqual(first.RUNTIME_PROXY_SOCKET, second.RUNTIME_PROXY_SOCKET);
      assert.equal(
        (
          await adapter.api.releaseIfIdle({
            agentId: "a",
            requestId: "old-policy",
            expectedGeneration: first.RUNTIME_PROXY_CONNECTION_ID + ":" + randomUUID(),
          })
        ).status,
        "generation-changed",
      );
      const { writeFile } = await import("node:fs/promises");
      const contents = JSON.parse(await readFile(recipe.RUNTIME_PROXY_RECIPE_FILE!, "utf8"));
      contents.recordsDirectory = join(directory, "unrelated");
      await writeFile(recipe.RUNTIME_PROXY_RECIPE_FILE!, JSON.stringify(contents));
      await assert.rejects(
        claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!),
        /Invalid connection directory/,
      );
      assert.equal(
        (await readdir(join(directory, "connections"))).filter((name) => name.endsWith(".json"))
          .length,
        1,
      );
    } finally {
      for (const env of cleanups)
        await rm(dirname(env.RUNTIME_PROXY_SOCKET!), { recursive: true, force: true });
    }
  },
);

test(
  "Claude runtime uses the shared ownership/generation boundary and reports hook capability",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, peer } = await setup(t);
    const { record, state } = await peer("claude", "claude");
    const [running] = await adapter.api.snapshot({ agentIds: ["claude"] });
    assert.equal(running!.provider, "claude");
    assert.equal(running!.presence, "running");
    assert.equal(running!.controlStatus, "available");
    state.backgroundTasks = 1;
    assert.equal((await adapter.api.snapshot({ agentIds: ["claude"] }))[0]!.activity, "background");
    assert.equal(
      (
        await adapter.api.releaseIfIdle({
          agentId: "claude",
          expectedGeneration: record.connectionId + ":" + state.generation,
          requestId: "stop",
        })
      ).status,
      "busy",
    );
    state.backgroundTasks = 0;
    state.sessionCrons = 1;
    assert.equal((await adapter.api.snapshot({ agentIds: ["claude"] }))[0]!.activity, "background");
    state.sessionCrons = 0;
    state.releaseSupported = false;
    state.unavailableReason = "Claude SDK hooks must be enabled.";
    const [disabled] = await adapter.api.snapshot({ agentIds: ["claude"] });
    assert.equal(disabled!.releasable, false);
    assert.equal(disabled!.unavailableReason, state.unavailableReason);
    assert.equal(disabled!.presence, "running");
  },
);

test(
  "provider-scoped recipes and lease cleanup never adopt another provider or remove changed records",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { adapter, directory } = await setup(t);
    const recipe = await adapter.prepareSession({
      agentId: "claude",
      provider: "claude",
      purpose: "interactive",
    });
    await assert.rejects(
      claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!, "codex"),
      /Invalid launch identity/,
    );
    assert.deepEqual(await readdir(join(directory, "connections")), []);
    const env = await claimProxyConnection(recipe.RUNTIME_PROXY_RECIPE_FILE!, "claude");
    const cleanup = await ownProxyLease("claude", env);
    await assert.rejects(ownProxyLease("codex", env), /identity mismatch/);
    const { writeFile } = await import("node:fs/promises");
    const contents = await readFile(env.RUNTIME_PROXY_CONNECTION_FILE!, "utf8");
    const changed = JSON.parse(contents);
    changed.token = "0".repeat(64);
    await writeFile(env.RUNTIME_PROXY_CONNECTION_FILE!, JSON.stringify(changed));
    await assert.rejects(cleanup(), /changed.*preserving/);
    assert.ok(await readFile(env.RUNTIME_PROXY_CONNECTION_FILE!, "utf8"));
    await writeFile(env.RUNTIME_PROXY_CONNECTION_FILE!, contents);
    await cleanup();
    await cleanup();
    assert.deepEqual(await readdir(join(directory, "connections")), []);
    await assert.rejects(stat(dirname(env.RUNTIME_PROXY_SOCKET!)), /ENOENT/);
  },
);
